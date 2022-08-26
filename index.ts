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
import { Construct } from 'constructs';
import { App, CustomResource, Stack, StackProps } from 'aws-cdk-lib'; 
import { aws_s3, aws_ecs, aws_logs, aws_lambda, aws_iam, aws_ecr_assets, aws_ecs_patterns, custom_resources } from 'aws-cdk-lib';  
import { aws_elasticloadbalancingv2 as lb } from 'aws-cdk-lib';  

import * as fs from 'fs'
import { exit } from 'process'

const path = require('path')

const app = new App()

export class WebvizStack extends Stack {
    targetBucket: aws_s3.IBucket

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const webviz_folder = 'webviz_source'
        const webviz_dockerfile = 'Dockerfile-static-webviz'

        if (!fs.existsSync(path.join(__dirname, webviz_folder, webviz_dockerfile))) {
            console.error('Dockerfile not found. Please run ./build_dependencies.sh to clone webviz locally first')
            exit(1)
        }

        const webvizImageAsset = new aws_ecr_assets.DockerImageAsset(this, 'MyBuildImage', {
            directory: path.join(__dirname, webviz_folder),
            file: webviz_dockerfile
          });

        const app = new aws_ecs_patterns.ApplicationLoadBalancedFargateService(this, 'webviz_service', {
            taskImageOptions: {
                image: aws_ecs.EcrImage.fromDockerImageAsset(webvizImageAsset), // Or reference the public Docker image directly https://hub.docker.com/r/cruise/webviz
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
            this.targetBucket = aws_s3.Bucket.fromBucketName(this, 'bucketRef', bucketName)

            const onEvent = new aws_lambda.Function(this, 'corsLambda', {
                code: aws_lambda.Code.fromAsset(path.join(__dirname, 'lambda', 'put_cors')),
                handler: 'main.lambda_handler',
                runtime: aws_lambda.Runtime.PYTHON_3_8,
                role: new aws_iam.Role(this, 'lambdaPutCorsRulesRole', {
                    assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
                    managedPolicies: [aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
                    inlinePolicies: {
                        'allow-put-cors': new aws_iam.PolicyDocument({
                            statements: [new aws_iam.PolicyStatement({
                                actions: ['s3:PutBucketCORS'],
                                resources: [this.targetBucket.bucketArn],
                                effect: aws_iam.Effect.ALLOW
                            })]
                        })
                    }
                })
            });

            const corsCustomProvider = new custom_resources.Provider(this, 'corsCustomProvider', {
                onEventHandler: onEvent,
                logRetention: aws_logs.RetentionDays.ONE_MONTH
            });

            new CustomResource(this, 'putCorsRulesCustomResource', {
                serviceToken: corsCustomProvider.serviceToken, properties: {
                    "bucket_name": this.targetBucket.bucketName,
                    "allowed_origin": webviz_url
                }
            });
        } else {
            this.targetBucket = new aws_s3.Bucket(this, 'webviz_bucket', {
                bucketName,
                cors: [{
                    allowedHeaders: ["*"],
                    allowedMethods: [aws_s3.HttpMethods.HEAD, aws_s3.HttpMethods.GET],
                    allowedOrigins: [webviz_url],
                    exposedHeaders: ["ETag", "Content-Type", "Accept-Ranges", "Content-Length"]
                }]
            })
        }

        const generateUrlLambdaRole = new aws_iam.Role(this, 'generateUrlLambdaRole', {
            assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
            inlinePolicies: {
                'dynamo-get-item': new aws_iam.PolicyDocument({
                    statements: [new aws_iam.PolicyStatement({
                        actions: ['dynamodb:GetItem'],
                        resources: ['*'],
                        effect: aws_iam.Effect.ALLOW
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

        const generateUrlLambda = new aws_lambda.Function(this, 'generateUrlLambda', {
            code: aws_lambda.Code.fromAsset(path.join(__dirname, 'lambda', 'generate_url')),
            handler: 'main.lambda_handler',
            functionName: generateUrlFunctionName,
            runtime: aws_lambda.Runtime.PYTHON_3_8,
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