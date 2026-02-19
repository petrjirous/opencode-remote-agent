import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { fromIni } from "@aws-sdk/credential-providers";

export interface RemoteAgentConfig {
  /** AWS region to deploy to */
  awsRegion: string;
  /** AWS CLI profile to use (default: "default") */
  awsProfile: string;
  /** Name prefix for all AWS resources */
  resourcePrefix: string;
  /** S3 bucket name for task results */
  s3BucketName: string;
  /** ECS cluster name */
  ecsClusterName: string;
  /** ECS task definition family name */
  taskDefinitionFamily: string;
  /** CloudWatch log group name */
  logGroupName: string;
  /** Container image URI in ECR */
  containerImageUri: string;
  /** Default task CPU (in vCPU units: 256, 512, 1024, 2048, 4096) */
  defaultCpu: string;
  /** Default task memory (in MB: 512, 1024, 2048, ..., 30720) */
  defaultMemory: string;
  /** Default task timeout in seconds */
  defaultTimeoutSeconds: number;
  /** Subnets to launch tasks in (populated after CDK deploy) */
  subnetIds: string[];
  /** Security group for tasks (populated after CDK deploy) */
  securityGroupId: string;
}

export const DEFAULT_CONFIG: RemoteAgentConfig = {
  awsRegion: "us-east-1",
  awsProfile: "default",
  resourcePrefix: "remote-agent",
  s3BucketName: "",
  ecsClusterName: "",
  taskDefinitionFamily: "",
  logGroupName: "/ecs/remote-agent",
  containerImageUri: "",
  defaultCpu: "1024",
  defaultMemory: "4096",
  defaultTimeoutSeconds: 7200, // 2 hours
  subnetIds: [],
  securityGroupId: "",
};

/** Cached stack outputs so we only query CloudFormation once per process */
let stackOutputsCache: Partial<RemoteAgentConfig> | null = null;
let stackOutputsError: string | null = null;

/**
 * Query CloudFormation for the RemoteAgentStack outputs.
 * Returns partial config values discovered from the stack.
 * Results are cached for the lifetime of the process.
 */
async function discoverFromCloudFormation(
  region: string,
  profile: string,
): Promise<Partial<RemoteAgentConfig>> {
  if (stackOutputsCache) return stackOutputsCache;
  if (stackOutputsError) return {};

  try {
    const cfn = new CloudFormationClient({
      region,
      credentials: fromIni({ profile }),
    });

    const resp = await cfn.send(
      new DescribeStacksCommand({ StackName: "RemoteAgentStack" }),
    );

    const outputs = resp.Stacks?.[0]?.Outputs ?? [];
    const get = (key: string) =>
      outputs.find((o) => o.OutputKey === key)?.OutputValue;

    stackOutputsCache = {
      s3BucketName: get("BucketName") ?? undefined,
      ecsClusterName: get("ClusterName") ?? undefined,
      taskDefinitionFamily: get("TaskFamily") ?? undefined,
      logGroupName: get("LogGroupName") ?? undefined,
      containerImageUri: get("RepositoryUri")
        ? `${get("RepositoryUri")}:latest`
        : undefined,
      subnetIds: get("SubnetIds")?.split(",").filter(Boolean) ?? undefined,
      securityGroupId: get("SecurityGroupId") ?? undefined,
    };

    // Remove undefined values so they don't override defaults
    for (const [k, v] of Object.entries(stackOutputsCache)) {
      if (v === undefined) delete (stackOutputsCache as Record<string, unknown>)[k];
    }

    return stackOutputsCache;
  } catch {
    stackOutputsError = "CloudFormation stack not found or not accessible";
    return {};
  }
}

/**
 * Load config by merging: defaults → CloudFormation stack outputs → env vars → explicit overrides.
 *
 * The CloudFormation auto-discovery means users only need to deploy the CDK stack
 * and the plugin will find all resource names automatically.
 */
export function loadConfig(
  overrides?: Partial<RemoteAgentConfig>,
): RemoteAgentConfig {
  const envOverrides: Partial<RemoteAgentConfig> = {};

  if (process.env.REMOTE_AGENT_AWS_REGION)
    envOverrides.awsRegion = process.env.REMOTE_AGENT_AWS_REGION;
  if (process.env.REMOTE_AGENT_AWS_PROFILE)
    envOverrides.awsProfile = process.env.REMOTE_AGENT_AWS_PROFILE;
  if (process.env.REMOTE_AGENT_S3_BUCKET)
    envOverrides.s3BucketName = process.env.REMOTE_AGENT_S3_BUCKET;
  if (process.env.REMOTE_AGENT_ECS_CLUSTER)
    envOverrides.ecsClusterName = process.env.REMOTE_AGENT_ECS_CLUSTER;
  if (process.env.REMOTE_AGENT_CONTAINER_IMAGE)
    envOverrides.containerImageUri = process.env.REMOTE_AGENT_CONTAINER_IMAGE;
  if (process.env.REMOTE_AGENT_SUBNET_IDS)
    envOverrides.subnetIds =
      process.env.REMOTE_AGENT_SUBNET_IDS.split(",").filter(Boolean);
  if (process.env.REMOTE_AGENT_SECURITY_GROUP_ID)
    envOverrides.securityGroupId =
      process.env.REMOTE_AGENT_SECURITY_GROUP_ID;

  // Merge: defaults → env vars → explicit overrides
  // CloudFormation discovery is done asynchronously via loadConfigAsync()
  return {
    ...DEFAULT_CONFIG,
    ...envOverrides,
    ...overrides,
  };
}

/**
 * Async version that also queries CloudFormation for stack outputs.
 * Use this in tools that need the full config with infrastructure details.
 *
 * Priority: defaults → CloudFormation outputs → env vars → explicit overrides
 */
export async function loadConfigAsync(
  overrides?: Partial<RemoteAgentConfig>,
): Promise<RemoteAgentConfig> {
  // Start with defaults + env vars
  const base = loadConfig(overrides);

  // Only query CloudFormation if key fields are missing
  const needsDiscovery =
    !base.s3BucketName ||
    !base.containerImageUri ||
    base.subnetIds.length === 0 ||
    !base.securityGroupId ||
    !base.ecsClusterName ||
    !base.taskDefinitionFamily;

  if (!needsDiscovery) return base;

  const cfnOutputs = await discoverFromCloudFormation(
    base.awsRegion,
    base.awsProfile,
  );

  // CloudFormation fills in gaps but env vars still take precedence
  return {
    ...DEFAULT_CONFIG,
    ...cfnOutputs,
    ...Object.fromEntries(
      Object.entries(base).filter(([k]) => {
        const val = base[k as keyof RemoteAgentConfig];
        // Only include non-default values from base
        const def = DEFAULT_CONFIG[k as keyof RemoteAgentConfig];
        return val !== def;
      }),
    ),
    ...overrides,
  };
}

/** Reset the cached stack outputs (e.g., after a deploy) */
export function resetConfigCache(): void {
  stackOutputsCache = null;
  stackOutputsError = null;
}
