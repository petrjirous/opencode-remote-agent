/**
 * Task Tracker — auto-polls running remote tasks and injects status
 * updates into the OpenCode session.
 *
 * Architecture:
 *   - Each tracked task gets a setInterval that polls S3 metadata + CloudWatch logs
 *   - Status changes and key log milestones are injected via injectRawOutput()
 *   - On completion: shows patch summary, elapsed time, and how to apply
 *   - Polling stops automatically on completion/failure/cancel
 *   - stopAll() cleans up everything (call on session end)
 */

import type { RemoteAgentConfig } from "./config.js";
import { getTaskMetadata, getPatch, type TaskResult } from "./aws/s3.js";
import { getTaskLogs } from "./aws/ecs.js";

/** How often to poll S3 metadata (ms) */
const METADATA_POLL_INTERVAL = 15_000; // 15s

/** How often to poll CloudWatch logs (ms) — slightly offset from metadata */
const LOG_POLL_INTERVAL = 20_000; // 20s

/** Max age before we stop polling a task (ms) — safety net */
const MAX_POLL_DURATION = 12 * 60 * 60 * 1000; // 12 hours

/** Callback to inject text into the session */
export type InjectFn = (sessionID: string, text: string) => Promise<void>;

/** Callback to send a prompt to the LLM (triggers response) */
export type PromptFn = (sessionID: string, text: string) => Promise<void>;

interface TrackedTask {
  taskId: string;
  sessionID: string;
  shortId: string;
  promptPreview: string;
  startedAt: number;
  lastStatus: string;
  lastLogCount: number;
  /** Lines already seen — avoids duplicate injection */
  seenLogLines: Set<string>;
  metadataTimer: ReturnType<typeof setInterval>;
  logTimer: ReturnType<typeof setInterval>;
  /** Whether we've already reported completion */
  finalized: boolean;
}

export class TaskTracker {
  private tasks = new Map<string, TrackedTask>();
  private config: RemoteAgentConfig;
  private inject: InjectFn;

  constructor(config: RemoteAgentConfig, inject: InjectFn) {
    this.config = config;
    this.inject = inject;
  }

  /** Update the config (e.g., after async discovery) */
  setConfig(config: RemoteAgentConfig): void {
    this.config = config;
  }

  /**
   * Start tracking a task. Begins polling for status updates and logs.
   */
  track(taskId: string, sessionID: string, prompt: string): void {
    // Don't double-track
    if (this.tasks.has(taskId)) return;

    const shortId = taskId.slice(0, 8);
    const promptPreview =
      prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt;

    const tracked: TrackedTask = {
      taskId,
      sessionID,
      shortId,
      promptPreview,
      startedAt: Date.now(),
      lastStatus: "PROVISIONING",
      lastLogCount: 0,
      seenLogLines: new Set(),
      metadataTimer: null as unknown as ReturnType<typeof setInterval>,
      logTimer: null as unknown as ReturnType<typeof setInterval>,
      finalized: false,
    };

    // Metadata polling — checks S3 for status changes
    tracked.metadataTimer = setInterval(
      () => this.pollMetadata(tracked),
      METADATA_POLL_INTERVAL,
    );

    // Log polling — checks CloudWatch for new log lines
    tracked.logTimer = setInterval(
      () => this.pollLogs(tracked),
      LOG_POLL_INTERVAL,
    );

    this.tasks.set(taskId, tracked);
  }

  /**
   * Stop tracking a specific task.
   */
  untrack(taskId: string): void {
    const tracked = this.tasks.get(taskId);
    if (!tracked) return;
    clearInterval(tracked.metadataTimer);
    clearInterval(tracked.logTimer);
    this.tasks.delete(taskId);
  }

  /**
   * Stop tracking all tasks. Call when the plugin/session is shutting down.
   */
  stopAll(): void {
    for (const [taskId] of this.tasks) {
      this.untrack(taskId);
    }
  }

  /**
   * Check if a task is being tracked.
   */
  isTracking(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /**
   * Get count of actively tracked tasks.
   */
  get activeCount(): number {
    return this.tasks.size;
  }

  // ── Internal polling ──────────────────────────────────────────────

  private async pollMetadata(tracked: TrackedTask): Promise<void> {
    // Safety: stop polling if we've been at it too long
    if (Date.now() - tracked.startedAt > MAX_POLL_DURATION) {
      await this.inject(
        tracked.sessionID,
        `⏱ [remote-agent] Task ${tracked.shortId} — polling stopped (exceeded max duration)`,
      );
      this.untrack(tracked.taskId);
      return;
    }

    try {
      const metadata = await getTaskMetadata(this.config, tracked.taskId);
      if (!metadata) return; // Not written yet

      const newStatus = metadata.status;

      // Report status changes
      if (newStatus !== tracked.lastStatus) {
        tracked.lastStatus = newStatus;

        if (newStatus === "running") {
          const elapsed = this.formatElapsed(tracked.startedAt);
          await this.inject(
            tracked.sessionID,
            `▶ [remote-agent] Task ${tracked.shortId} is now running (${elapsed} since launch)`,
          );
        }
      }

      // Handle terminal states
      if (
        !tracked.finalized &&
        (newStatus === "completed" ||
          newStatus === "failed" ||
          newStatus === "cancelled")
      ) {
        tracked.finalized = true;
        await this.reportCompletion(tracked, metadata);
        this.untrack(tracked.taskId);
      }
    } catch {
      // Silently ignore polling errors — we'll retry next interval
    }
  }

  private async pollLogs(tracked: TrackedTask): Promise<void> {
    if (tracked.finalized) return;

    try {
      const logs = await getTaskLogs(this.config, tracked.taskId, 50);

      // Filter to milestone lines only (lines starting with ===)
      // and any Error lines — avoid flooding the session with noise
      const milestones = logs.filter((line) => {
        const msg = line.replace(/^\[.*?\]\s*/, ""); // strip timestamp
        return (
          msg.startsWith("=== ") ||
          msg.includes("Error:") ||
          msg.startsWith("Changes detected:") ||
          msg.startsWith("No file changes") ||
          msg.startsWith("Using model:") ||
          msg.startsWith("Workspace extracted:") ||
          msg.startsWith("Auth written to") ||
          msg.startsWith("Prompt loaded from S3:")
        );
      });

      // Find new milestones we haven't seen
      const newMilestones = milestones.filter(
        (line) => !tracked.seenLogLines.has(line),
      );

      if (newMilestones.length > 0) {
        for (const line of newMilestones) {
          tracked.seenLogLines.add(line);
        }

        // Format and inject
        const formatted = newMilestones
          .map((line) => {
            // Strip ANSI codes and timestamp prefix, clean up
            const clean = line
              .replace(/^\[.*?\]\s*/, "")
              .replace(/\u001b\[[0-9;]*m/g, "")
              .trim();
            return `  ${clean}`;
          })
          .filter((l) => l.trim().length > 0)
          .join("\n");

        if (formatted.trim()) {
          const elapsed = this.formatElapsed(tracked.startedAt);
          await this.inject(
            tracked.sessionID,
            `📋 [remote-agent] Task ${tracked.shortId} (${elapsed}):\n${formatted}`,
          );
        }
      }
    } catch {
      // CloudWatch logs may not be available yet — silently ignore
    }
  }

  private async reportCompletion(
    tracked: TrackedTask,
    metadata: TaskResult,
  ): Promise<void> {
    const elapsed = this.formatElapsed(tracked.startedAt);
    const lines: string[] = [];

    if (metadata.status === "completed") {
      lines.push(
        `✅ [remote-agent] Task ${tracked.shortId} completed (${elapsed})`,
      );

      if (metadata.exitCode !== undefined && metadata.exitCode !== 0) {
        lines.push(`   Exit code: ${metadata.exitCode}`);
      }

      // Check for patch
      try {
        const patch = await getPatch(this.config, tracked.taskId);
        if (patch && patch.trim().length > 0) {
          const patchLines = patch.split("\n").length;
          const patchBytes = patch.length;

          // Parse patch to get file change summary
          const fileSummary = this.parsePatchSummary(patch);

          lines.push(`   Patch: ${patchLines} lines (${this.formatBytes(patchBytes)})`);
          if (fileSummary.length > 0) {
            lines.push(`   Files changed:`);
            for (const f of fileSummary.slice(0, 10)) {
              lines.push(`     ${f}`);
            }
            if (fileSummary.length > 10) {
              lines.push(`     ... and ${fileSummary.length - 10} more`);
            }
          }
          lines.push(``);
          lines.push(
            `   Apply with: remote_status tool (task_id="${tracked.taskId}", apply_patch=true)`,
          );
        } else {
          lines.push(`   No file changes were made.`);
        }
      } catch {
        lines.push(`   Could not check patch status.`);
      }
    } else if (metadata.status === "failed") {
      lines.push(
        `❌ [remote-agent] Task ${tracked.shortId} failed (${elapsed})`,
      );
      if (metadata.error) {
        lines.push(`   Error: ${metadata.error}`);
      }
      if (metadata.exitCode !== undefined) {
        lines.push(`   Exit code: ${metadata.exitCode}`);
      }
      lines.push(``);
      lines.push(
        `   View logs: remote_status tool (task_id="${tracked.taskId}", include_logs=true)`,
      );
    } else if (metadata.status === "cancelled") {
      lines.push(
        `🚫 [remote-agent] Task ${tracked.shortId} was cancelled (${elapsed})`,
      );
    }

    if (lines.length > 0) {
      await this.inject(tracked.sessionID, lines.join("\n"));
    }
  }

  /**
   * Parse a unified diff patch to extract changed file names with +/- stats.
   */
  private parsePatchSummary(patch: string): string[] {
    const files: string[] = [];
    const lines = patch.split("\n");

    let currentFile = "";
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith("diff --git")) {
        // Flush previous file
        if (currentFile) {
          files.push(`${currentFile} (+${additions}/-${deletions})`);
        }
        // Extract filename from "diff --git a/foo b/foo"
        const match = line.match(/diff --git a\/.+ b\/(.+)/);
        currentFile = match?.[1] ?? "unknown";
        additions = 0;
        deletions = 0;
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
      }
    }

    // Flush last file
    if (currentFile) {
      files.push(`${currentFile} (+${additions}/-${deletions})`);
    }

    return files;
  }

  private formatElapsed(startedAt: number): string {
    const ms = Date.now() - startedAt;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    if (mins < 60) return `${mins}m ${remainSecs}s`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
