

#!/usr/bin/env python3
import os
import sys
import json
import boto3
from argparse import ArgumentParser
from urllib.parse import quote_plus
from botocore.config import Config

def main():
    with open('./cdk.json') as cdk_json:
        cdk_config = json.load(cdk_json)
    parser = ArgumentParser(description='Request a Presigned URL from the generateUrlLambda')
    parser.add_argument('--region',
                        dest='region',
                        default=cdk_config["context"]["region"],
                        help='AWS Region to which the CDK stack is deployed and the bucket resides')
    parser.add_argument('--bucket-name',
                        dest='bucket_name',
                        default=cdk_config["context"]["bucketName"],
                        help='the name of the bucket containing rosbag file')
    parser.add_argument('--function-name',
                        dest='function_name',
                        default=cdk_config["context"]["generateUrlFunctionName"],
                        help='The generateUrlFunctionName')
    parser.add_argument('--key',
                        dest='object_key',
                        help='the key of the object in s3')
    parser.add_argument('--record',
                        dest='record_id',
                        help='the partition key of the scene in the scenario db')
    parser.add_argument('--scene',
                        dest='scene_id',
                        help='the sort key of the scene in the scenario db')
    args = parser.parse_args()

    if args.object_key is None and (args.record_id is None or args.scene_id is None):
        raise Exception('You need to either specify --key or --record and --scene')
    config = Config(
        region_name = args.region
    )
    client = boto3.client('lambda', config=config)
    print('Invoking: ' + str(args.function_name))
    payload = {
            "bucket": args.bucket_name,
            "key": args.object_key,
            "record_id": args.record_id,
            "scene_id": args.scene_id
        }
    print('payload: ' + json.dumps(payload))
    response = client.invoke(
        FunctionName=str(args.function_name),
        InvocationType='RequestResponse',
        LogType='Tail',
        Payload=json.dumps(payload)
    )

    res = json.loads(response['Payload'].read())
    statusCode = int(res.get('statusCode'))
    body = json.loads(res.get('body'))
  
    print(str(statusCode))
    if statusCode == 200:
        url = body.get('url')
        print(url)
    else:
        print(json.dumps(body))

if __name__ == '__main__':
    main()