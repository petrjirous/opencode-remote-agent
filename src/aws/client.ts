import { ECSClient } from "@aws-sdk/client-ecs";
import { S3Client } from "@aws-sdk/client-s3";
import {
  CloudWatchLogsClient,
} from "@aws-sdk/client-cloudwatch-logs";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import type { RemoteAgentConfig } from "../config.js";

let ecsClient: ECSClient | null = null;
let s3Client: S3Client | null = null;
let logsClient: CloudWatchLogsClient | null = null;
let stsClient: STSClient | null = null;

function getCredentials(config: RemoteAgentConfig) {
  return fromIni({ profile: config.awsProfile });
}

export function getECSClient(config: RemoteAgentConfig): ECSClient {
  if (!ecsClient) {
    ecsClient = new ECSClient({
      region: config.awsRegion,
      credentials: getCredentials(config),
    });
  }
  return ecsClient;
}

export function getS3Client(config: RemoteAgentConfig): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: config.awsRegion,
      credentials: getCredentials(config),
    });
  }
  return s3Client;
}

export function getLogsClient(
  config: RemoteAgentConfig,
): CloudWatchLogsClient {
  if (!logsClient) {
    logsClient = new CloudWatchLogsClient({
      region: config.awsRegion,
      credentials: getCredentials(config),
    });
  }
  return logsClient;
}

export function getSTSClient(config: RemoteAgentConfig): STSClient {
  if (!stsClient) {
    stsClient = new STSClient({
      region: config.awsRegion,
      credentials: getCredentials(config),
    });
  }
  return stsClient;
}

/**
 * Verify AWS credentials are valid and return account info.
 */
export async function verifyAwsCredentials(
  config: RemoteAgentConfig,
): Promise<{ account: string; arn: string }> {
  const sts = getSTSClient(config);
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return {
    account: identity.Account ?? "unknown",
    arn: identity.Arn ?? "unknown",
  };
}

/**
 * Reset all cached clients (e.g., after config change).
 */
export function resetClients(): void {
  ecsClient = null;
  s3Client = null;
  logsClient = null;
  stsClient = null;
}
