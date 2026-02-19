import { tool } from "@opencode-ai/plugin";
import { loadConfigAsync } from "../config.js";
import { getTaskMetadata, putTaskMetadata } from "../aws/s3.js";
import { stopEcsTask } from "../aws/ecs.js";

export const remoteCancelTool = tool({
  description:
    "Cancel a running remote OpenCode agent task. " +
    "This stops the ECS Fargate task and marks it as cancelled.",
  args: {
    task_id: tool.schema
      .string()
      .describe("The task ID to cancel (from remote_run)"),
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
      // Update metadata in S3
      const metadata = await getTaskMetadata(config, args.task_id);
      if (!metadata) {
        return `No task found with ID: ${args.task_id}`;
      }

      if (metadata.status !== "running") {
        return `Task ${args.task_id} is already ${metadata.status}, cannot cancel.`;
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
      await putTaskMetadata(config, args.task_id, metadata);

      context.metadata({ title: `Task ${args.task_id.slice(0, 8)} cancelled` });
      return `Task ${args.task_id} has been cancelled.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error cancelling task: ${message}`;
    }
  },
});
