import { tool } from "@opencode-ai/plugin";
import { randomUUID } from "crypto";
import { loadConfigAsync } from "../config.js";
import { runRemoteTask } from "../aws/ecs.js";
import {
  packageWorkspace,
  uploadWorkspace,
  getTarballSize,
} from "../workspace.js";
import {
  extractSessionContext,
  buildRemotePrompt,
  uploadSessionContext,
} from "../session-context.js";
import { getClient, getTracker } from "../shared.js";

export const remoteRunTool = tool({
  description:
    "Launch an OpenCode agent task on a remote AWS ECS Fargate container. " +
    "Automatically uploads your local workspace (codebase with uncommitted changes) " +
    "and current session context so the remote agent can continue where you left off. " +
    "Use this to offload long-running coding tasks (refactors, migrations, " +
    "test suites, full feature implementations) to an ephemeral cloud environment. " +
    "Returns a task ID for tracking progress. Use remote_status to check results " +
    "and apply the generated patch back to your local workspace.",
  args: {
    prompt: tool.schema
      .string()
      .describe(
        "The task prompt to send to the remote agent. Be specific and detailed about what you want done.",
      ),
    repo_url: tool.schema
      .string()
      .optional()
      .describe(
        "Git repository URL to clone into the container workspace instead of uploading local files " +
          "(e.g., https://github.com/user/repo.git). If set, include_workspace defaults to false.",
      ),
    branch: tool.schema
      .string()
      .optional()
      .describe(
        "Git branch to checkout after cloning (defaults to main/master)",
      ),
    cpu: tool.schema
      .enum(["256", "512", "1024", "2048", "4096"])
      .optional()
      .describe(
        "CPU allocation in Fargate units. 256=0.25 vCPU, 1024=1 vCPU, 4096=4 vCPU. Default: 1024",
      ),
    memory: tool.schema
      .enum(["512", "1024", "2048", "4096", "8192", "16384", "30720"])
      .optional()
      .describe("Memory allocation in MB. Default: 4096 (4GB)"),
    timeout_minutes: tool.schema
      .number()
      .int()
      .min(1)
      .max(720)
      .optional()
      .describe(
        "Maximum runtime in minutes before the task is killed. Default: 120 (2 hours). Max: 720 (12 hours)",
      ),
    include_workspace: tool.schema
      .boolean()
      .optional()
      .describe(
        "Upload local workspace to the container (default: true). " +
          "Packages all tracked and untracked files (respecting .gitignore) and sends them to the remote environment. " +
          "Set to false if using repo_url instead.",
      ),
    include_session_context: tool.schema
      .boolean()
      .optional()
      .describe(
        "Include current session context/summary for continuity (default: true). " +
          "Extracts conversation history and passes it to the remote agent so it understands " +
          "what has been discussed and decided so far.",
      ),
  },
  async execute(args, context) {
    context.metadata({ title: "Launching remote agent task..." });

    const config = await loadConfigAsync();

    if (!config.containerImageUri) {
      return (
        "Error: Remote agent infrastructure is not set up yet. " +
          "Please run the remote_setup tool first to deploy the required AWS resources."
      );
    }

    if (config.subnetIds.length === 0 || !config.securityGroupId) {
      return (
        "Error: Network configuration is missing. " +
          "Please run the remote_setup tool to deploy the infrastructure."
      );
    }

    try {
      // Pre-generate task ID so we can upload workspace & prompt before launching
      const taskId = randomUUID();
      let workspaceS3Key: string | undefined;
      let promptS3Key: string | undefined;
      const statusParts: string[] = [];

      // Log workspace resolution for debugging
      statusParts.push(
        `Workspace resolution: directory="${context.directory}", worktree="${context.worktree}", cwd="${process.cwd()}"`,
      );

      // 1. Package and upload workspace
      const shouldUploadWorkspace =
        args.include_workspace !== false && !args.repo_url;
      if (shouldUploadWorkspace) {
        context.metadata({ title: "Packaging workspace..." });
        const tarballPath = await packageWorkspace(
          context.directory,
          context.worktree,
        );
        const size = getTarballSize(tarballPath);
        context.metadata({ title: `Uploading workspace (${size})...` });
        workspaceS3Key = await uploadWorkspace(config, taskId, tarballPath);
        statusParts.push(`Workspace uploaded: ${size}`);
      }

      // 2. Extract session context and build enriched prompt
      let finalPrompt = args.prompt;
      const shouldIncludeContext = args.include_session_context !== false;
      if (shouldIncludeContext) {
        context.metadata({ title: "Extracting session context..." });
        try {
          const client = getClient();
          const sessionContext = await extractSessionContext(
            client,
            context.sessionID,
          );
          finalPrompt = buildRemotePrompt(sessionContext, args.prompt);
          statusParts.push("Session context included");
        } catch {
          // Non-fatal — fall back to raw prompt without session context
          statusParts.push(
            "Session context skipped (extraction failed, using raw prompt)",
          );
        }
      }

      // 3. Always upload prompt to S3 (avoids 8KB ECS overrides limit)
      context.metadata({ title: "Uploading prompt..." });
      promptS3Key = await uploadSessionContext(config, taskId, finalPrompt);

      // 4. Launch the ECS task
      context.metadata({ title: "Launching ECS task..." });
      const result = await runRemoteTask(config, {
        taskId,
        prompt: args.prompt,
        repoUrl: args.repo_url,
        branch: args.branch,
        cpu: args.cpu,
        memory: args.memory,
        timeoutSeconds: args.timeout_minutes
          ? args.timeout_minutes * 60
          : undefined,
        workspaceS3Key,
        promptS3Key,
      });

      context.metadata({
        title: `Remote task launched: ${result.taskId.slice(0, 8)}...`,
      });

      // Start auto-polling for status updates and log milestones
      const tracker = getTracker();
      if (tracker) {
        try {
          const trackerConfig = await loadConfigAsync();
          tracker.setConfig(trackerConfig);
          tracker.track(result.taskId, context.sessionID, args.prompt);
          statusParts.push("Auto-tracking enabled (live status updates)");
        } catch {
          statusParts.push(
            "Auto-tracking not started (config unavailable)",
          );
        }
      }

      return [
        `Remote agent task launched successfully!`,
        ``,
        `Task ID: ${result.taskId}`,
        `ECS Task ARN: ${result.ecsTaskArn}`,
        `Status: ${result.status}`,
        ...(statusParts.length > 0
          ? [``, `Sync:`, ...statusParts.map((s) => `  - ${s}`)]
          : []),
        ``,
        `The remote container has your codebase and session context.`,
        `OpenCode is running your task on AWS Fargate.`,
        ``,
        `You'll receive live status updates and log milestones automatically.`,
        `When complete, use remote_status with apply_patch=true to apply changes locally.`,
        `Use /remote-watch stop to disable tracking.`,
      ].join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error launching remote task: ${message}`;
    }
  },
});
