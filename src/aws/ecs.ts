import {
  RunTaskCommand,
  DescribeTasksCommand,
  StopTaskCommand,
  type KeyValuePair,
} from "@aws-sdk/client-ecs";
import {
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { getECSClient, getLogsClient } from "./client.js";
import type { RemoteAgentConfig } from "../config.js";
import { getContainerAuth } from "../auth.js";
import { putObject, putTaskMetadata, type TaskResult } from "./s3.js";
import { randomUUID } from "crypto";

export interface RunTaskOptions {
  /** The task/prompt to send to the remote agent */
  prompt: string;
  /** Optional git repo URL to clone into the container */
  repoUrl?: string;
  /** Optional git branch to checkout */
  branch?: string;
  /** CPU override (Fargate units) */
  cpu?: string;
  /** Memory override (MB) */
  memory?: string;
  /** Timeout in seconds */
  timeoutSeconds?: number;
  /** Additional environment variables */
  extraEnv?: Array<{ name: string; value: string }>;
  /** S3 key for workspace tarball (uploaded by plugin before launch) */
  workspaceS3Key?: string;
  /** S3 key for full prompt (avoids 8KB ECS overrides limit) */
  promptS3Key?: string;
  /** Pre-generated task ID (if not provided, a UUID will be generated) */
  taskId?: string;
}

export interface RunTaskResult {
  taskId: string;
  ecsTaskArn: string;
  status: string;
}

/**
 * Upload auth credentials to S3 so the container can download them at startup.
 * This avoids putting large OAuth tokens in the ECS overrides (8KB limit).
 *
 * The auth payload can be either:
 *   - "opencode-auth": Full OpenCode auth.json — written to ~/.local/share/opencode/auth.json
 *   - "env-vars": Simple key=value pairs — exported as env vars (for direct API keys)
 *
 * @returns The S3 key and format indicator.
 */
async function uploadAuthToS3(
  config: RemoteAgentConfig,
  taskId: string,
): Promise<{ key: string; format: string }> {
  const auth = getContainerAuth();
  const key = `tasks/${taskId}/auth.json`;
  await putObject(config, key, auth.payload, "application/json");
  return { key, format: auth.format };
}

/**
 * Launch a Fargate task to run OpenCode with the given prompt.
 *
 * Large values (auth token, prompt) are uploaded to S3 and only their
 * S3 keys are passed as env vars. This keeps the ECS RunTask overrides
 * well under the 8192-character limit.
 */
export async function runRemoteTask(
  config: RemoteAgentConfig,
  options: RunTaskOptions,
): Promise<RunTaskResult> {
  const ecs = getECSClient(config);
  const taskId = options.taskId ?? randomUUID();

  // Upload auth credentials to S3 (avoids large OAuth tokens in overrides)
  const authUpload = await uploadAuthToS3(config, taskId);

  // Build environment variables — only small values and S3 keys
  const containerEnv: KeyValuePair[] = [
    { name: "TASK_ID", value: taskId },
    { name: "S3_BUCKET", value: config.s3BucketName },
    { name: "AWS_DEFAULT_REGION", value: config.awsRegion },
    {
      name: "TASK_TIMEOUT",
      value: String(options.timeoutSeconds ?? config.defaultTimeoutSeconds),
    },
    { name: "OPENCODE", value: "1" },
    { name: "AUTH_S3_KEY", value: authUpload.key },
    { name: "AUTH_FORMAT", value: authUpload.format },
  ];

  // Forward model selection if configured
  if (process.env.REMOTE_AGENT_MODEL) {
    containerEnv.push({
      name: "REMOTE_AGENT_MODEL",
      value: process.env.REMOTE_AGENT_MODEL,
    });
  }

  // Prompt is always via S3 key (uploaded by remote-run tool before calling us)
  if (options.promptS3Key) {
    containerEnv.push({ name: "PROMPT_S3_KEY", value: options.promptS3Key });
  }
  // Short fallback prompt only if no S3 key — for direct CLI testing
  if (!options.promptS3Key) {
    containerEnv.push({
      name: "TASK_PROMPT",
      value: options.prompt.slice(0, 500),
    });
  }

  // Pass workspace S3 key if workspace was uploaded
  if (options.workspaceS3Key) {
    containerEnv.push({
      name: "WORKSPACE_S3_KEY",
      value: options.workspaceS3Key,
    });
  }

  if (options.repoUrl) {
    containerEnv.push({ name: "GIT_REPO_URL", value: options.repoUrl });
  }
  if (options.branch) {
    containerEnv.push({ name: "GIT_BRANCH", value: options.branch });
  }
  if (options.extraEnv) {
    containerEnv.push(
      ...options.extraEnv.map((e) => ({ name: e.name, value: e.value })),
    );
  }

  const resp = await ecs.send(
    new RunTaskCommand({
      cluster: config.ecsClusterName,
      taskDefinition: config.taskDefinitionFamily,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.subnetIds,
          securityGroups: [config.securityGroupId],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        cpu: options.cpu ?? config.defaultCpu,
        memory: options.memory ?? config.defaultMemory,
        containerOverrides: [
          {
            name: "remote-agent",
            environment: containerEnv,
            cpu: parseInt(options.cpu ?? config.defaultCpu),
            memory: parseInt(options.memory ?? config.defaultMemory),
          },
        ],
      },
      tags: [
        { key: "remote-agent:task-id", value: taskId },
        {
          key: "remote-agent:prompt",
          // ECS tags only allow UTF-8 letters, spaces, numbers, and _ . / = + - : @
          // Replace newlines/tabs with spaces first, then strip any remaining invalid chars
          value: options.prompt
            .replace(/[\r\n\t]+/g, " ")
            .replace(/[^\w ./:=+\-@]/g, "")
            .replace(/ {2,}/g, " ")
            .trim()
            .slice(0, 255),
        },
      ],
    }),
  );

  const ecsTask = resp.tasks?.[0];
  if (!ecsTask?.taskArn) {
    const failure = resp.failures?.[0];
    throw new Error(
      `Failed to launch ECS task: ${failure?.reason ?? "unknown error"}`,
    );
  }

  // Store initial metadata in S3
  const metadata: TaskResult = {
    taskId,
    status: "running",
    prompt: options.prompt,
    startedAt: new Date().toISOString(),
  };
  await putTaskMetadata(config, taskId, metadata);

  return {
    taskId,
    ecsTaskArn: ecsTask.taskArn,
    status: ecsTask.lastStatus ?? "PROVISIONING",
  };
}

/**
 * Get the status of an ECS task by its ARN.
 */
export async function describeEcsTask(
  config: RemoteAgentConfig,
  taskArn: string,
): Promise<{
  status: string;
  stoppedReason?: string;
  exitCode?: number;
}> {
  const ecs = getECSClient(config);
  const resp = await ecs.send(
    new DescribeTasksCommand({
      cluster: config.ecsClusterName,
      tasks: [taskArn],
    }),
  );

  const task = resp.tasks?.[0];
  if (!task) {
    return { status: "NOT_FOUND" };
  }

  const container = task.containers?.[0];
  return {
    status: task.lastStatus ?? "UNKNOWN",
    stoppedReason: task.stoppedReason,
    exitCode: container?.exitCode,
  };
}

/**
 * Stop a running ECS task.
 */
export async function stopEcsTask(
  config: RemoteAgentConfig,
  taskArn: string,
): Promise<void> {
  const ecs = getECSClient(config);
  await ecs.send(
    new StopTaskCommand({
      cluster: config.ecsClusterName,
      task: taskArn,
      reason: "Cancelled by user via remote-agent plugin",
    }),
  );
}

/**
 * Fetch recent CloudWatch logs for a task.
 */
export async function getTaskLogs(
  config: RemoteAgentConfig,
  taskId: string,
  limit: number = 100,
): Promise<string[]> {
  const logs = getLogsClient(config);

  try {
    const resp = await logs.send(
      new GetLogEventsCommand({
        logGroupName: config.logGroupName,
        logStreamName: `remote-agent/${taskId}`,
        limit,
        startFromHead: false,
      }),
    );

    return (resp.events ?? []).map(
      (e) => `[${new Date(e.timestamp ?? 0).toISOString()}] ${e.message}`,
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ResourceNotFoundException"
    ) {
      return ["No logs available yet for this task."];
    }
    throw err;
  }
}
