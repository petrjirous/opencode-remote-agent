/**
 * Module-level holder for the OpenCode SDK client.
 * Set during plugin initialization, read by tool modules that need
 * access to session APIs (e.g., extracting session context).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;

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
