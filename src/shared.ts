/**
 * Module-level holders for the OpenCode SDK client and TaskTracker.
 * Set during plugin initialization, read by tool modules that need
 * access to session APIs (e.g., extracting session context) or
 * the auto-polling task tracker.
 */

import type { TaskTracker } from "./task-tracker.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;
let _tracker: TaskTracker | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setClient(client: any): void {
  _client = client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getClient(): any {
  if (!_client) {
    throw new Error(
      "Plugin client not initialized. Ensure RemoteAgentPlugin has been loaded by OpenCode.",
    );
  }
  return _client;
}

export function setTracker(tracker: TaskTracker): void {
  _tracker = tracker;
}

export function getTracker(): TaskTracker | null {
  return _tracker;
}
