/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import 'source-map-support/register'
import * as cdk from '@aws-cdk/core'
import { ApplicationLoadBalancedFargateService } from '@aws-cdk/aws-ecs-patterns'
import * as ecs from '@aws-cdk/aws-ecs'
import * as s3 from '@aws-cdk/aws-s3'
import * as lb from '@aws-cdk/aws-elasticloadbalancingv2'
import { CustomResource } from '@aws-cdk/core';
import * as logs from '@aws-cdk/aws-logs';
import * as cr from '@aws-cdk/custom-resources';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
const path = require('path')

const app = new cdk.App()

export class WebvizStack extends cdk.Stack {
    targetBucket: s3.IBucket

    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const app = new ApplicationLoadBalancedFargateService(this, 'webviz_service', {
            taskImageOptions: {
                image: ecs.ContainerImage.fromRegistry('cruise/webviz'),
                containerPort: 8080
            }
        })

        const loadbalancer = app.loadBalancer.node.defaultChild as lb.CfnLoadBalancer
        // explicitly set the load balancer name to something lowercase to ensure CORS settings work
        loadbalancer.name = 'webviz-lb'

        const webviz_url = `http://${app.loadBalancer.loadBalancerDnsName}`
        const bucketName = app.node.tryGetContext('bucketName')
        const bucketExists = app.node.tryGetContext('bucketExists')
        const dbConfig = app.node.tryGetContext('scenarioDB')
        const generateUrlFunctionName = app.node.tryGetContext('generateUrlFunctionName')
        
        if (bucketExists) {
            this.targetBucket = s3.Bucket.fromBucketName(this, 'bucketRef', bucketName)

            const onEvent = new lambda.Function(this, 'corsLambda', {
                code: lambda.Code.fromAsset(path.join(__dirname, 'lambda', 'put_cors')),
                handler: 'main.lambda_handler',
                runtime: lambda.Runtime.PYTHON_3_8,
                role: new iam.Role(this, 'lambdaPutCorsRulesRole', {
                    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
                    inlinePolicies: {
                        'allow-put-cors': new iam.PolicyDocument({
                            statements: [new iam.PolicyStatement({
                                actions: ['s3:PutBucketCORS'],
                                resources: [this.targetBucket.bucketArn],
                                effect: iam.Effect.ALLOW
                            })]
                        })
                    }
                })
            });

            const corsCustomProvider = new cr.Provider(this, 'corsCustomProvider', {
                onEventHandler: onEvent,
                logRetention: logs.RetentionDays.ONE_MONTH
            });

            new CustomResource(this, 'putCorsRulesCustomResource', {
                serviceToken: corsCustomProvider.serviceToken, properties: {
                    "bucket_name": this.targetBucket.bucketName,
                    "allowed_origin": webviz_url
                }
            });
        } else {
            this.targetBucket = new s3.Bucket(this, 'webviz_bucket', {
                bucketName,
                cors: [{
                    allowedHeaders: ["*"],
                    allowedMethods: [s3.HttpMethods.HEAD, s3.HttpMethods.GET],
                    allowedOrigins: [webviz_url],
                    exposedHeaders: ["ETag", "Content-Type", "Accept-Ranges", "Content-Length"]
                }]
            })
        }

        const generateUrlLambdaRole = new iam.Role(this, 'generateUrlLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
            inlinePolicies: {
                'dynamo-get-item': new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                        actions: ['dynamodb:GetItem'],
                        resources: ['*'],
                        effect: iam.Effect.ALLOW
                    })]
                })
            }
        })

        this.targetBucket.grantRead(generateUrlLambdaRole)

        let lambdaEnvs: any = {}
        if (dbConfig) {
            lambdaEnvs['SCENE_DB_PARTITION_KEY'] = dbConfig.partitionKey,
            lambdaEnvs['SCENE_DB_SORT_KEY'] = dbConfig.sortKey,
            lambdaEnvs['SCENE_DB_REGION'] = dbConfig.region,
            lambdaEnvs['SCENE_DB_TABLE'] = dbConfig.tableName
        }

        const generateUrlLambda = new lambda.Function(this, 'generateUrlLambda', {
            code: lambda.Code.fromAsset(path.join(__dirname, 'lambda', 'generate_url')),
            handler: 'main.lambda_handler',
            functionName: generateUrlFunctionName,
            runtime: lambda.Runtime.PYTHON_3_8,
            environment: {
                'WEBVIZ_ELB_URL': webviz_url,
                ...lambdaEnvs
            },
            role: generateUrlLambdaRole
        });
    }
}

const region = app.node.tryGetContext("region")

new WebvizStack(app, 'WebvizStack', { env: { region }});
app.synth()