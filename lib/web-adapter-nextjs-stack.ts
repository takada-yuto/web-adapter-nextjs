import * as cdk from "aws-cdk-lib"
import {
  CachePolicy,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  ImportSource,
} from "aws-cdk-lib/aws-cloudfront"
import { Platform } from "aws-cdk-lib/aws-ecr-assets"
import { DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda"
import { Construct } from "constructs"
import { readFileSync } from "fs"

export class WebAdapterNextjsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // Lambdaの定義
    const handler = new DockerImageFunction(this, "Handler", {
      code: DockerImageCode.fromImageAsset("./frontend", {
        platform: Platform.LINUX_AMD64,
      }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(300),
    })

    const keyValueStore = new cdk.aws_cloudfront.KeyValueStore(
      this,
      "KeyValueStore",
      {
        keyValueStoreName: "ip-restriction",
        source: ImportSource.fromInline(
          JSON.stringify({
            data: [
              {
                key: "allowIps",
                value: "152.165.121.190",
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
          readFileSync("./lambda/ip-restriction.js", "utf8")
            .replace(/\n/g, "")
            .replace("KVS_ID", keyValueStore.keyValueStoreId)
        ),
        runtime: FunctionRuntime.JS_2_0,
        keyValueStore,
      }
    )

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
      },
      enableLogging: true,
      httpVersion: cdk.aws_cloudfront.HttpVersion.HTTP2_AND_3,
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
