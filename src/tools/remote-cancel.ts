import { tool } from "@opencode-ai/plugin";
import { loadConfigAsync } from "../config.js";
import { getTaskMetadata, putTaskMetadata, resolveTaskId } from "../aws/s3.js";
import { stopEcsTask } from "../aws/ecs.js";

export const remoteCancelTool = tool({
  description:
    "Cancel a running remote OpenCode agent task. " +
    "This stops the ECS Fargate task and marks it as cancelled.",
  args: {
    task_id: tool.schema
      .string()
      .describe("The task ID to cancel (full UUID or short prefix from remote_list)"),
    ecs_task_arn: tool.schema
      .string()
      .optional()
      .describe(
        "ECS task ARN (if known). If not provided, will try to stop by task ID.",
      ),
  },
  async execute(args, context) {
    context.metadata({ title: `Cancelling task ${args.task_id.slice(0, 8)}...` });

    const config = await loadConfigAsync();

    try {
      // Resolve short/prefix task ID to full UUID
      const fullTaskId = await resolveTaskId(config, args.task_id);
      if (!fullTaskId) {
        return `No task found with ID: ${args.task_id}`;
      }

      // Update metadata in S3
      const metadata = await getTaskMetadata(config, fullTaskId);
      if (!metadata) {
        return `No task found with ID: ${args.task_id}`;
      }

      if (metadata.status !== "running") {
        return `Task ${fullTaskId} is already ${metadata.status}, cannot cancel.`;
      }

      // Stop the ECS task if we have the ARN
      if (args.ecs_task_arn) {
        try {
          await stopEcsTask(config, args.ecs_task_arn);
        } catch (err) {
          // Task may have already stopped
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("is not in the RUNNING")) {
            return `Error stopping ECS task: ${msg}`;
          }
        }
      }

      // Update S3 metadata
      metadata.status = "cancelled";
      metadata.completedAt = new Date().toISOString();
      await putTaskMetadata(config, fullTaskId, metadata);

      context.metadata({ title: `Task ${fullTaskId.slice(0, 8)} cancelled` });
      return `Task ${fullTaskId} has been cancelled.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error cancelling task: ${message}`;
    }
  },
});
