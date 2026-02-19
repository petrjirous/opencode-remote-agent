import { tool } from "@opencode-ai/plugin";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadConfigAsync } from "../config.js";
import { getTaskMetadata, getTaskOutput, getPatch } from "../aws/s3.js";
import { getTaskLogs } from "../aws/ecs.js";

export const remoteStatusTool = tool({
  description:
    "Check the status of a remote OpenCode agent task. " +
    "Returns the current status, any output produced so far, " +
    "recent log entries, and the changes patch if available. " +
    "Use apply_patch=true to automatically apply remote changes to your local workspace.",
  args: {
    task_id: tool.schema
      .string()
      .describe("The task ID returned by remote_run"),
    include_logs: tool.schema
      .boolean()
      .optional()
      .describe("Include recent CloudWatch logs (default: false)"),
    log_lines: tool.schema
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Number of log lines to fetch (default: 50)"),
    apply_patch: tool.schema
      .boolean()
      .optional()
      .describe(
        "If true and a changes patch is available, apply it to the local workspace " +
          "using git apply. The patch contains all file changes made by the remote agent. " +
          "(default: false)",
      ),
    download_patch: tool.schema
      .boolean()
      .optional()
      .describe(
        "If true, include the full patch content in the response (default: auto — " +
          "included if patch is small, omitted if large)",
      ),
  },
  async execute(args, context) {
    context.metadata({
      title: `Checking task ${args.task_id.slice(0, 8)}...`,
    });

    const config = await loadConfigAsync();

    try {
      const metadata = await getTaskMetadata(config, args.task_id);
      if (!metadata) {
        return `No task found with ID: ${args.task_id}`;
      }

      const lines: string[] = [
        `## Remote Task Status`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| Task ID | ${metadata.taskId} |`,
        `| Status | ${metadata.status} |`,
        `| Prompt | ${metadata.prompt.slice(0, 100)}${metadata.prompt.length > 100 ? "..." : ""} |`,
        `| Started | ${metadata.startedAt} |`,
      ];

      if (metadata.completedAt) {
        lines.push(`| Completed | ${metadata.completedAt} |`);
        const durationMs =
          new Date(metadata.completedAt).getTime() -
          new Date(metadata.startedAt).getTime();
        const durationMin = Math.round(durationMs / 60000);
        lines.push(`| Duration | ${durationMin} min |`);
      }

      if (metadata.exitCode !== undefined) {
        lines.push(`| Exit Code | ${metadata.exitCode} |`);
      }

      if (metadata.error) {
        lines.push(``, `### Error`, `\`\`\``, metadata.error, `\`\`\``);
      }

      // Try to get output
      if (metadata.status === "completed" || metadata.status === "failed") {
        const output = await getTaskOutput(config, args.task_id);
        if (output) {
          lines.push(
            ``,
            `### Output`,
            `\`\`\``,
            output.length > 10000
              ? output.slice(0, 10000) +
                  "\n... (truncated, full output in S3)"
              : output,
            `\`\`\``,
          );
        }

        // Check for changes patch
        const patch = await getPatch(config, args.task_id);
        if (patch && patch.trim().length > 0) {
          const patchLines = patch.split("\n").length;
          const patchSize = patch.length;

          lines.push(
            ``,
            `### Changes Patch`,
            `Patch available: ${patchLines} lines, ${patchSize} bytes`,
          );

          if (args.apply_patch) {
            // Apply the patch to local workspace
            const tmpPath = join(
              "/tmp",
              `remote-agent-${args.task_id.slice(0, 8)}.patch`,
            );
            writeFileSync(tmpPath, patch, "utf-8");

            try {
              const applyOutput = execSync(
                `git apply --stat "${tmpPath}" && git apply "${tmpPath}"`,
                {
                  cwd: context.directory,
                  encoding: "utf-8",
                  timeout: 30000,
                },
              );
              lines.push(
                ``,
                `**Patch applied successfully to ${context.directory}**`,
              );
              if (applyOutput.trim()) {
                lines.push(`\`\`\``, applyOutput.trim(), `\`\`\``);
              }
            } catch (applyErr) {
              const msg =
                applyErr instanceof Error ? applyErr.message : String(applyErr);
              lines.push(
                ``,
                `**Failed to apply patch:**`,
                `\`\`\``,
                msg.slice(0, 2000),
                `\`\`\``,
                ``,
                `Patch saved to: ${tmpPath}`,
                `You can manually apply it with: \`git apply "${tmpPath}"\``,
                `Or try with --3way: \`git apply --3way "${tmpPath}"\``,
              );
            }
          } else if (args.download_patch || patchSize < 5000) {
            // Show the patch content inline
            lines.push(
              `\`\`\`diff`,
              patchSize > 10000
                ? patch.slice(0, 10000) + "\n... (truncated)"
                : patch,
              `\`\`\``,
            );
            if (!args.apply_patch) {
              lines.push(
                ``,
                `To apply these changes locally, use remote_status with apply_patch=true.`,
              );
            }
          } else {
            lines.push(
              ``,
              `Patch is ${patchSize} bytes. Use download_patch=true to view it, ` +
                `or apply_patch=true to apply it directly.`,
            );
          }
        } else if (metadata.status === "completed") {
          lines.push(
            ``,
            `### Changes`,
            `No file changes were made by the remote agent.`,
          );
        }
      }

      // Optionally include logs
      if (args.include_logs) {
        const logs = await getTaskLogs(
          config,
          args.task_id,
          args.log_lines ?? 50,
        );
        lines.push(``, `### Recent Logs`, `\`\`\``, ...logs, `\`\`\``);
      }

      context.metadata({
        title: `Task ${args.task_id.slice(0, 8)}: ${metadata.status}`,
      });
      return lines.join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error checking task status: ${message}`;
    }
  },
});
