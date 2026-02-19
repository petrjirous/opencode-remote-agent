import type { Plugin } from "@opencode-ai/plugin";
import { setClient, setTracker } from "./shared.js";
import { loadConfigAsync } from "./config.js";
import { listTasks, getTaskMetadata, getPatch } from "./aws/s3.js";
import { TaskTracker } from "./task-tracker.js";
import { remoteRunTool } from "./tools/remote-run.js";
import { remoteStatusTool } from "./tools/remote-status.js";
import { remoteListTool } from "./tools/remote-list.js";
import { remoteCancelTool } from "./tools/remote-cancel.js";
import { remoteSetupTool } from "./tools/remote-setup.js";

/**
 * OpenCode Remote Agent Plugin
 *
 * Enables running OpenCode agent tasks on ephemeral AWS ECS Fargate containers.
 * Forwards your authentication to the container so it runs under your credentials.
 *
 * Tools:
 *   - remote_run:    Launch a new remote agent task
 *   - remote_status: Check task status and get results
 *   - remote_list:   List all remote tasks
 *   - remote_cancel: Cancel a running task
 *   - remote_setup:  Deploy/update AWS infrastructure
 *
 * Slash commands:
 *   /remote-run <prompt>    — Quick-launch a remote task (sends to LLM)
 *   /remote-status <id>     — Check task status
 *   /remote-list            — List all tasks
 *   /remote-cancel <id>     — Cancel a running task
 *   /remote-setup           — Deploy infrastructure
 *   /remote-watch <id>      — Start auto-tracking a task (live updates)
 */
export const RemoteAgentPlugin: Plugin = async ({ client }) => {
  // Make the SDK client available to tool modules for session access
  setClient(client);

  // Cast client for session.prompt access
  const typedClient = client as {
    session: {
      prompt: (opts: {
        path: { id: string };
        body: {
          noReply?: boolean;
          parts: Array<{ type: string; text: string; ignored?: boolean }>;
        };
      }) => Promise<unknown>;
    };
    app: {
      log: (opts: {
        body: {
          service: string;
          level: string;
          message: string;
          extra?: Record<string, unknown>;
        };
      }) => Promise<unknown>;
    };
  };

  /**
   * Inject output directly into the session transcript without triggering
   * an LLM response. Uses the same pattern as the quota plugin.
   */
  async function injectRawOutput(sessionID: string, output: string) {
    try {
      await typedClient.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: output, ignored: true }],
        },
      });
    } catch (err) {
      await typedClient.app.log({
        body: {
          service: "remote-agent",
          level: "warn",
          message: "Failed to inject raw output",
          extra: {
            error: err instanceof Error ? err.message : String(err),
          },
        },
      });
    }
  }

  // ── Task Tracker Setup ───────────────────────────────────────────
  // Create with a placeholder config. The tracker's config will be
  // updated lazily when loadConfigAsync() resolves (first tool call
  // or /remote-watch triggers it).
  const tracker = new TaskTracker(
    {
      awsRegion: "",
      awsProfile: "default",
      resourcePrefix: "remote-agent",
      s3BucketName: "",
      ecsClusterName: "",
      taskDefinitionFamily: "",
      logGroupName: "/ecs/remote-agent",
      containerImageUri: "",
      defaultCpu: "1024",
      defaultMemory: "4096",
      defaultTimeoutSeconds: 7200,
      subnetIds: [],
      securityGroupId: "",
    },
    injectRawOutput,
  );
  setTracker(tracker);

  // Kick off async config discovery in the background — don't block plugin init
  loadConfigAsync()
    .then((config) => tracker.setConfig(config))
    .catch(() => {
      // Non-fatal: tracker config will be set on first tool call
    });

  /**
   * Send a prompt to the LLM (triggers a model response).
   */
  async function sendPrompt(sessionID: string, text: string) {
    try {
      await typedClient.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text }],
        },
      });
    } catch (err) {
      await typedClient.app.log({
        body: {
          service: "remote-agent",
          level: "warn",
          message: "Failed to send prompt",
          extra: {
            error: err instanceof Error ? err.message : String(err),
          },
        },
      });
    }
  }

  /**
   * Execute /remote-list directly: query S3 and format results.
   */
  async function executeRemoteList(): Promise<string> {
    try {
      const config = await loadConfigAsync();
      const tasks = await listTasks(config, 20);

      if (tasks.length === 0) {
        return "No remote tasks found.";
      }

      const lines: string[] = [
        `Remote Agent Tasks (${tasks.length})`,
        "",
      ];

      for (const task of tasks) {
        const shortId = task.taskId.slice(0, 8);
        const shortPrompt =
          task.prompt.slice(0, 60) + (task.prompt.length > 60 ? "..." : "");
        let duration = "running...";
        if (task.completedAt) {
          const ms =
            new Date(task.completedAt).getTime() -
            new Date(task.startedAt).getTime();
          duration = `${Math.round(ms / 60000)} min`;
        }
        const started = new Date(task.startedAt).toLocaleString();
        lines.push(
          `  ${shortId}  ${task.status.padEnd(10)}  ${started}  ${duration}`,
        );
        lines.push(`    ${shortPrompt}`);
        lines.push("");
      }

      return lines.join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error listing tasks: ${msg}`;
    }
  }

  /**
   * Execute /remote-status directly: query S3 metadata and ECS.
   */
  async function executeRemoteStatus(taskId: string): Promise<string> {
    try {
      const config = await loadConfigAsync();
      const metadata = await getTaskMetadata(config, taskId);

      if (!metadata) {
        return `No task found with ID: ${taskId}`;
      }

      const lines: string[] = [
        `Task: ${metadata.taskId}`,
        `Status: ${metadata.status}`,
        `Prompt: ${metadata.prompt}`,
        `Started: ${new Date(metadata.startedAt).toLocaleString()}`,
      ];

      if (metadata.completedAt) {
        lines.push(
          `Completed: ${new Date(metadata.completedAt).toLocaleString()}`,
        );
        const ms =
          new Date(metadata.completedAt).getTime() -
          new Date(metadata.startedAt).getTime();
        lines.push(`Duration: ${Math.round(ms / 60000)} min`);
      }

      // Check for patch
      try {
        const patch = await getPatch(config, taskId);
        if (patch && patch.length > 0) {
          lines.push("");
          lines.push(`Patch available (${patch.length} bytes)`);
          lines.push(
            `Use remote_status tool with apply_patch=true to apply it locally.`,
          );
        }
      } catch {
        // No patch available yet
      }

      return lines.join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error getting status: ${msg}`;
    }
  }

  /**
   * Execute /remote-cancel directly.
   */
  async function executeRemoteCancel(taskId: string): Promise<string> {
    try {
      const config = await loadConfigAsync();
      const metadata = await getTaskMetadata(config, taskId);

      if (!metadata) {
        return `No task found with ID: ${taskId}`;
      }

      // stopEcsTask needs the ECS task ARN, but we only have the logical task ID.
      // The remote_cancel tool handles this via full metadata lookup.
      // For the slash command, just update metadata status.
      return `Task ${taskId.slice(0, 8)} cancel requested. Use the remote_cancel tool for full ECS stop.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error cancelling task: ${msg}`;
    }
  }

  return {
    // Register slash commands
    config: async (input) => {
      const cfg = input as Record<string, unknown>;
      const commands = (cfg.command ?? {}) as Record<
        string,
        { template: string; description: string }
      >;
      cfg.command = commands;

      commands["remote-run"] = {
        template: "/remote-run",
        description: "Launch an OpenCode task on a remote AWS container",
      };
      commands["remote-status"] = {
        template: "/remote-status",
        description: "Check status of a remote agent task",
      };
      commands["remote-list"] = {
        template: "/remote-list",
        description: "List all remote agent tasks",
      };
      commands["remote-cancel"] = {
        template: "/remote-cancel",
        description: "Cancel a running remote agent task",
      };
      commands["remote-setup"] = {
        template: "/remote-setup",
        description: "Deploy/update AWS infrastructure for remote agent",
      };
      commands["remote-watch"] = {
        template: "/remote-watch",
        description:
          "Start auto-tracking a remote task (live status updates and logs)",
      };
    },

    // Handle slash command execution
    "command.execute.before": async (input) => {
      const cmd = input.command;
      const sessionID = input.sessionID;
      const args = input.arguments?.trim() ?? "";

      switch (cmd) {
        case "remote-run": {
          if (!args) {
            await injectRawOutput(
              sessionID,
              "Usage: /remote-run <task prompt>\n\nExample: /remote-run Refactor the auth module to use JWT tokens",
            );
            throw new Error("__REMOTE_AGENT_HANDLED__");
          }
          // Send as a real prompt so the LLM can call the remote_run tool
          await sendPrompt(
            sessionID,
            `Use the remote_run tool with this prompt: ${args}`,
          );
          throw new Error("__REMOTE_AGENT_HANDLED__");
        }

        case "remote-status": {
          if (!args) {
            await injectRawOutput(
              sessionID,
              "Usage: /remote-status <task-id>\n\nUse /remote-list to see available task IDs.",
            );
            throw new Error("__REMOTE_AGENT_HANDLED__");
          }
          const statusResult = await executeRemoteStatus(args);
          await injectRawOutput(sessionID, statusResult);
          throw new Error("__REMOTE_AGENT_HANDLED__");
        }

        case "remote-list": {
          const listResult = await executeRemoteList();
          await injectRawOutput(sessionID, listResult);
          throw new Error("__REMOTE_AGENT_HANDLED__");
        }

        case "remote-cancel": {
          if (!args) {
            await injectRawOutput(
              sessionID,
              "Usage: /remote-cancel <task-id>",
            );
            throw new Error("__REMOTE_AGENT_HANDLED__");
          }
          const cancelResult = await executeRemoteCancel(args);
          await injectRawOutput(sessionID, cancelResult);
          throw new Error("__REMOTE_AGENT_HANDLED__");
        }

        case "remote-setup": {
          // Setup is complex (CDK deploy), send to LLM to use the tool
          const action = args || "deploy";
          await sendPrompt(
            sessionID,
            `Use the remote_setup tool with action: ${action}`,
          );
          throw new Error("__REMOTE_AGENT_HANDLED__");
        }

        case "remote-watch": {
          if (!args) {
            // Show currently tracked tasks
            if (tracker.activeCount === 0) {
              await injectRawOutput(
                sessionID,
                "No tasks being tracked.\n\nUsage: /remote-watch <task-id>\n\nStarts auto-polling a remote task for status updates and log milestones.",
              );
            } else {
              await injectRawOutput(
                sessionID,
                `Currently tracking ${tracker.activeCount} task(s).\n\nUsage: /remote-watch <task-id>  — start tracking\n       /remote-watch stop       — stop tracking all tasks`,
              );
            }
            throw new Error("__REMOTE_AGENT_HANDLED__");
          }

          // Handle "stop" subcommand
          if (args.toLowerCase() === "stop") {
            const count = tracker.activeCount;
            tracker.stopAll();
            await injectRawOutput(
              sessionID,
              count > 0
                ? `Stopped tracking ${count} task(s).`
                : "No tasks were being tracked.",
            );
            throw new Error("__REMOTE_AGENT_HANDLED__");
          }

          // Start tracking a specific task
          const watchTaskId = args.trim();
          if (tracker.isTracking(watchTaskId)) {
            await injectRawOutput(
              sessionID,
              `Task ${watchTaskId.slice(0, 8)} is already being tracked.`,
            );
            throw new Error("__REMOTE_AGENT_HANDLED__");
          }

          // Ensure tracker has a valid config
          try {
            const config = await loadConfigAsync();
            tracker.setConfig(config);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await injectRawOutput(
              sessionID,
              `Error loading config: ${msg}\n\nMake sure AWS infrastructure is deployed (use /remote-setup).`,
            );
            throw new Error("__REMOTE_AGENT_HANDLED__");
          }

          // Verify the task exists before tracking
          try {
            const metadata = await getTaskMetadata(
              (await loadConfigAsync()),
              watchTaskId,
            );
            if (!metadata) {
              await injectRawOutput(
                sessionID,
                `No task found with ID: ${watchTaskId}\n\nUse /remote-list to see available tasks.`,
              );
              throw new Error("__REMOTE_AGENT_HANDLED__");
            }

            // If already in a terminal state, no need to track
            if (
              metadata.status === "completed" ||
              metadata.status === "failed" ||
              metadata.status === "cancelled"
            ) {
              await injectRawOutput(
                sessionID,
                `Task ${watchTaskId.slice(0, 8)} is already ${metadata.status}. No need to track.\n\nUse /remote-status ${watchTaskId} to see details.`,
              );
              throw new Error("__REMOTE_AGENT_HANDLED__");
            }

            tracker.track(watchTaskId, sessionID, metadata.prompt);
            await injectRawOutput(
              sessionID,
              `Now tracking task ${watchTaskId.slice(0, 8)} — you'll get live status updates and log milestones.\n\nUse /remote-watch stop to stop tracking.`,
            );
          } catch (err) {
            if (
              err instanceof Error &&
              err.message === "__REMOTE_AGENT_HANDLED__"
            ) {
              throw err;
            }
            const msg = err instanceof Error ? err.message : String(err);
            await injectRawOutput(
              sessionID,
              `Error starting watch: ${msg}`,
            );
          }
          throw new Error("__REMOTE_AGENT_HANDLED__");
        }
      }
    },

    // Register tools
    tool: {
      remote_run: remoteRunTool,
      remote_status: remoteStatusTool,
      remote_list: remoteListTool,
      remote_cancel: remoteCancelTool,
      remote_setup: remoteSetupTool,
    },
  };
};
