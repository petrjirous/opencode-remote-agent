import { tool } from "@opencode-ai/plugin";
import { loadConfigAsync } from "../config.js";
import { listTasks } from "../aws/s3.js";

export const remoteListTool = tool({
  description:
    "List all remote OpenCode agent tasks, showing their status, " +
    "prompts, and timing. Most recent tasks are shown first.",
  args: {
    limit: tool.schema
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of tasks to list (default: 20)"),
    status_filter: tool.schema
      .enum(["running", "completed", "failed", "cancelled"])
      .optional()
      .describe("Filter tasks by status"),
  },
  async execute(args, context) {
    context.metadata({ title: "Listing remote tasks..." });

    const config = await loadConfigAsync();

    try {
      let tasks = await listTasks(config, args.limit ?? 20);

      if (args.status_filter) {
        tasks = tasks.filter((t) => t.status === args.status_filter);
      }

      if (tasks.length === 0) {
        return args.status_filter
          ? `No remote tasks found with status: ${args.status_filter}`
          : "No remote tasks found.";
      }

      const lines: string[] = [
        `## Remote Agent Tasks (${tasks.length})`,
        ``,
        `| Task ID | Status | Prompt | Started | Duration |`,
        `|---------|--------|--------|---------|----------|`,
      ];

      for (const task of tasks) {
        const shortId = task.taskId.slice(0, 8);
        const shortPrompt =
          task.prompt.slice(0, 50) + (task.prompt.length > 50 ? "..." : "");

        let duration = "running...";
        if (task.completedAt) {
          const ms =
            new Date(task.completedAt).getTime() -
            new Date(task.startedAt).getTime();
          duration = `${Math.round(ms / 60000)} min`;
        }

        const started = new Date(task.startedAt).toLocaleString();
        lines.push(
          `| ${shortId} | ${task.status} | ${shortPrompt} | ${started} | ${duration} |`,
        );
      }

      context.metadata({ title: `${tasks.length} remote tasks` });
      return lines.join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error listing tasks: ${message}`;
    }
  },
});
