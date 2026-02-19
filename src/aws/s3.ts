import {
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getS3Client } from "./client.js";
import type { RemoteAgentConfig } from "../config.js";

export interface TaskResult {
  taskId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  output?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  prompt: string;
  exitCode?: number;
  patchAvailable?: boolean;
  workspaceUploaded?: boolean;
}

/**
 * Store task metadata when launching.
 */
export async function putTaskMetadata(
  config: RemoteAgentConfig,
  taskId: string,
  metadata: TaskResult,
): Promise<void> {
  const s3 = getS3Client(config);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3BucketName,
      Key: `tasks/${taskId}/metadata.json`,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: "application/json",
    }),
  );
}

/**
 * Get task metadata/result.
 */
export async function getTaskMetadata(
  config: RemoteAgentConfig,
  taskId: string,
): Promise<TaskResult | null> {
  const s3 = getS3Client(config);
  try {
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3BucketName,
        Key: `tasks/${taskId}/metadata.json`,
      }),
    );
    const body = await resp.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as TaskResult;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "NoSuchKey"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Check if task result output exists.
 */
export async function hasTaskOutput(
  config: RemoteAgentConfig,
  taskId: string,
): Promise<boolean> {
  const s3 = getS3Client(config);
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: config.s3BucketName,
        Key: `tasks/${taskId}/output.txt`,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Get task output content.
 */
export async function getTaskOutput(
  config: RemoteAgentConfig,
  taskId: string,
): Promise<string | null> {
  const s3 = getS3Client(config);
  try {
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3BucketName,
        Key: `tasks/${taskId}/output.txt`,
      }),
    );
    return (await resp.Body?.transformToString()) ?? null;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "NoSuchKey"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Generic S3 put for arbitrary keys.
 */
export async function putObject(
  config: RemoteAgentConfig,
  key: string,
  body: string | Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const s3 = getS3Client(config);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3BucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Generic S3 get for arbitrary keys. Returns string content or null.
 */
export async function getObject(
  config: RemoteAgentConfig,
  key: string,
): Promise<string | null> {
  const s3 = getS3Client(config);
  try {
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3BucketName,
        Key: key,
      }),
    );
    return (await resp.Body?.transformToString()) ?? null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

/**
 * Get the change patch for a completed task.
 */
export async function getPatch(
  config: RemoteAgentConfig,
  taskId: string,
): Promise<string | null> {
  return getObject(config, `tasks/${taskId}/changes.patch`);
}

/**
 * List all task IDs (most recent first).
 */
export async function listTasks(
  config: RemoteAgentConfig,
  limit: number = 20,
): Promise<TaskResult[]> {
  const s3 = getS3Client(config);
  const resp = await s3.send(
    new ListObjectsV2Command({
      Bucket: config.s3BucketName,
      Prefix: "tasks/",
      Delimiter: "/",
    }),
  );

  const prefixes = resp.CommonPrefixes ?? [];
  const tasks: TaskResult[] = [];

  // Fetch metadata for each task (most recent first, limited)
  const taskIds = prefixes
    .map((p) => p.Prefix?.replace("tasks/", "").replace("/", "") ?? "")
    .filter(Boolean)
    .reverse()
    .slice(0, limit);

  for (const taskId of taskIds) {
    const metadata = await getTaskMetadata(config, taskId);
    if (metadata) {
      tasks.push(metadata);
    }
  }

  return tasks;
}
