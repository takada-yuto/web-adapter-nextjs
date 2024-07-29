import * as cdk from "aws-cdk-lib"
import {
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  ImportSource,
} from "aws-cdk-lib/aws-cloudfront"
import { Platform } from "aws-cdk-lib/aws-ecr-assets"
import { DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda"
import { Construct } from "constructs"
import { readFileSync } from "fs"
import * as dotenv from "dotenv"
import { RetentionDays } from "aws-cdk-lib/aws-logs"
import { Bucket } from "aws-cdk-lib/aws-s3"
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment"
import { PolicyStatement } from "aws-cdk-lib/aws-iam"

dotenv.config()

export class WebAdapterNextjsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)
    const IP_ADRESS = process.env.IP_ADRESS
    const BUCKET_NAME = process.env.BUCKET_NAME

    // コンテキストからバケット名を取得するか、新しいUUIDを使用してバケット名を生成
    const uniqueBucketName = BUCKET_NAME

    // コンテキストにバケット名を保存
    this.node.setContext("s3BucketName", uniqueBucketName)

    // S3バケットの作成
    const s3Bucket = new Bucket(this, "ConfigBucket", {
      bucketName: uniqueBucketName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    // S3バケットにenv.jsonファイルをアップロード
    new BucketDeployment(this, "DeployConfig", {
      sources: [Source.jsonData("env.json", { ip: IP_ADRESS })],
      destinationBucket: s3Bucket,
    })

    // Lambdaの定義
    const handler = new DockerImageFunction(this, "Handler", {
      code: DockerImageCode.fromImageAsset("./frontend", {
        platform: Platform.LINUX_AMD64,
      }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(300),
      logRetention: RetentionDays.ONE_WEEK,
    })

    // S3読み取り権限を持つIAMポリシーを作成
    const s3ReadPolicy = new PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [`${s3Bucket.bucketArn}/*`],
    })

    // Lambda関数にポリシーをアタッチ
    handler.addToRolePolicy(s3ReadPolicy)
    // Lambda関数にS3読み取り権限を付与
    s3Bucket.grantRead(handler)

    console.log(s3Bucket.bucketName)

    const keyValueStore = new cdk.aws_cloudfront.KeyValueStore(
      this,
      "KeyValueStore",
      {
        source: ImportSource.fromInline(
          JSON.stringify({
            data: [
              {
                key: "allowIps",
                value: IP_ADRESS,
              },
            ],
          })
        ),
      }
    )

    // CloudFrontにリクエストが来た際にIP制限を行うCloudFront Functionを作成
    const ipRestrictionFunction = new cdk.aws_cloudfront.Function(
      this,
      "ipRestrictionFunction",
      {
        code: FunctionCode.fromInline(
          readFileSync("./lambda/ip-restriction.js", "utf8").replace(
            "KVS_ID",
            keyValueStore.keyValueStoreId
          )
        ),
        runtime: FunctionRuntime.JS_2_0,
        keyValueStore,
      }
    )

    // Custom Cache Policy
    const customCachePolicy = new CachePolicy(this, "CustomCachePolicy", {
      cachePolicyName: "CustomCachePolicyWithClientIP",
      comment: "Cache policy that forwards x-client-ip header",
      headerBehavior: CacheHeaderBehavior.allowList("x-client-ip"),
      queryStringBehavior: CacheQueryStringBehavior.all(),
      cookieBehavior: CacheCookieBehavior.all(),
    })

    const distribution = new cdk.aws_cloudfront.Distribution(this, "Default", {
      defaultBehavior: {
        origin: new cdk.aws_cloudfront_origins.FunctionUrlOrigin(
          handler.addFunctionUrl({
            authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
          })
        ),
        viewerProtocolPolicy:
          cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy:
          cdk.aws_cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        functionAssociations: [
          {
            eventType: FunctionEventType.VIEWER_REQUEST,
            function: ipRestrictionFunction,
          },
        ],
        cachePolicy: customCachePolicy,
      },
      enableLogging: true,
      httpVersion: cdk.aws_cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: false,
    })

    // OAC
    const cfnOriginAccessControl =
      new cdk.aws_cloudfront.CfnOriginAccessControl(
        this,
        "OriginAccessControl",
        {
          originAccessControlConfig: {
            name: "Origin Access Control for Lambda Functions URL",
            originAccessControlOriginType: "lambda",
            signingBehavior: "always",
            signingProtocol: "sigv4",
          },
        }
      )

    const cfnDistribution = distribution.node
      .defaultChild as cdk.aws_cloudfront.CfnDistribution

    // Set OAC
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.OriginAccessControlId",
      cfnOriginAccessControl.attrId
    )

    // Add permission Lambda Function URLs
    handler.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new cdk.aws_iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${
        cdk.Stack.of(this).account
      }:distribution/${distribution.distributionId}`,
    })

    new cdk.CfnOutput(this, "DistributionDomain", {
      value: `https://${distribution.distributionDomainName}`,
    })
  }
}
