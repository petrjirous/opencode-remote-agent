import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface RemoteAgentStackProps extends cdk.StackProps {
  /** Prefix for all resource names */
  resourcePrefix?: string;
}

export class RemoteAgentStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly bucket: s3.Bucket;
  public readonly repository: ecr.Repository;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props?: RemoteAgentStackProps) {
    super(scope, id, props);

    const prefix = props?.resourcePrefix ?? "remote-agent";

    // --- VPC ---
    const vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `${prefix}-vpc`,
      maxAzs: 2,
      natGateways: 0, // Save costs — tasks use public IP
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Security group for tasks
    const securityGroup = new ec2.SecurityGroup(this, "TaskSG", {
      vpc,
      securityGroupName: `${prefix}-task-sg`,
      description: "Security group for remote agent ECS tasks",
      allowAllOutbound: true, // Tasks need internet for Claude API
    });

    // --- S3 Bucket for results ---
    this.bucket = new s3.Bucket(this, "ResultsBucket", {
      bucketName: `${prefix}-results-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "cleanup-old-results",
          expiration: cdk.Duration.days(30),
          prefix: "tasks/",
        },
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // --- ECR Repository ---
    this.repository = new ecr.Repository(this, "ContainerRepo", {
      repositoryName: `${prefix}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 5,
          description: "Keep only last 5 images",
        },
      ],
    });

    // --- CloudWatch Log Group ---
    this.logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/ecs/${prefix}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- ECS Cluster ---
    this.cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: `${prefix}-cluster`,
      vpc,
      containerInsights: false, // Save costs
    });

    // --- IAM Role for tasks ---
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: `${prefix}-task-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Role for remote agent ECS tasks",
    });

    // Allow tasks to read/write S3 results bucket
    this.bucket.grantReadWrite(taskRole);

    // Allow tasks to write CloudWatch logs
    this.logGroup.grantWrite(taskRole);

    const executionRole = new iam.Role(this, "ExecutionRole", {
      roleName: `${prefix}-execution-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });

    // --- ECS Task Definition ---
    this.taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        family: `${prefix}-task`,
        taskRole,
        executionRole,
        cpu: 1024,
        memoryLimitMiB: 4096,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      },
    );

    // Container definition
    this.taskDefinition.addContainer("remote-agent", {
      image: ecs.ContainerImage.fromEcrRepository(this.repository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: "remote-agent",
      }),
      essential: true,
      // Environment variables are injected at runtime via RunTask overrides
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "ClusterName", {
      value: this.cluster.clusterName,
      description: "ECS Cluster Name",
      exportName: `${prefix}-cluster-name`,
    });

    new cdk.CfnOutput(this, "TaskDefinitionArn", {
      value: this.taskDefinition.taskDefinitionArn,
      description: "ECS Task Definition ARN",
      exportName: `${prefix}-task-def-arn`,
    });

    new cdk.CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "S3 Results Bucket Name",
      exportName: `${prefix}-bucket-name`,
    });

    new cdk.CfnOutput(this, "RepositoryUri", {
      value: this.repository.repositoryUri,
      description: "ECR Repository URI",
      exportName: `${prefix}-ecr-uri`,
    });

    new cdk.CfnOutput(this, "SubnetIds", {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(","),
      description: "Public Subnet IDs",
      exportName: `${prefix}-subnet-ids`,
    });

    new cdk.CfnOutput(this, "SecurityGroupId", {
      value: securityGroup.securityGroupId,
      description: "Task Security Group ID",
      exportName: `${prefix}-sg-id`,
    });

    new cdk.CfnOutput(this, "LogGroupName", {
      value: this.logGroup.logGroupName,
      description: "CloudWatch Log Group Name",
      exportName: `${prefix}-log-group`,
    });

    new cdk.CfnOutput(this, "TaskFamily", {
      value: this.taskDefinition.family!,
      description: "ECS Task Definition Family",
      exportName: `${prefix}-task-family`,
    });
  }
}
