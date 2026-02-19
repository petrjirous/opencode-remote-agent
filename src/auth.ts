import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Resolve the OpenCode auth.json path (cross-platform).
 *
 * Follows XDG conventions:
 *   Linux:  ~/.local/share/opencode/auth.json
 *   macOS:  ~/.local/share/opencode/auth.json  (OpenCode uses the same path)
 */
function getAuthFilePath(): string {
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdgData, "opencode", "auth.json");
}

/**
 * Get the full OpenCode auth.json content to forward to the container.
 *
 * OpenCode uses OAuth tokens (not raw API keys) for providers like Anthropic.
 * These tokens cannot be passed as ANTHROPIC_API_KEY — they must be placed
 * in the auth.json file so `opencode run` picks them up natively.
 *
 * Lookup order:
 *   1. ANTHROPIC_API_KEY env var — wrap as a simple env-var-only auth payload
 *   2. OPENAI_API_KEY env var — same
 *   3. REMOTE_AGENT_AUTH_TOKEN env var — same
 *   4. OpenCode auth.json on disk — forward the entire file as-is
 *
 * Returns the auth payload as a JSON string, plus a flag indicating
 * whether it's an OpenCode auth.json format or a simple env var.
 */
export function getContainerAuth(): {
  /** The JSON string to upload to S3 */
  payload: string;
  /** "opencode-auth" = write as auth.json; "env-vars" = export as env vars */
  format: "opencode-auth" | "env-vars";
} {
  // 1. Direct API keys from environment — pass as env vars
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      payload: JSON.stringify({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
      format: "env-vars",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      payload: JSON.stringify({ OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
      format: "env-vars",
    };
  }
  if (process.env.REMOTE_AGENT_AUTH_TOKEN) {
    const provider = process.env.REMOTE_AGENT_PROVIDER ?? "anthropic";
    const envName = providerToEnvVar(provider);
    return {
      payload: JSON.stringify({ [envName]: process.env.REMOTE_AGENT_AUTH_TOKEN }),
      format: "env-vars",
    };
  }

  // 2. Read the full OpenCode auth.json and forward it
  const authPath = getAuthFilePath();
  if (existsSync(authPath)) {
    try {
      const raw = readFileSync(authPath, "utf-8");
      const auth = JSON.parse(raw);

      // Validate that there's at least one provider
      const provider = process.env.REMOTE_AGENT_PROVIDER ?? "anthropic";
      const entry = auth[provider];

      if (!entry?.access) {
        throw new Error(
          `No "${provider}" credentials found in ${authPath}. ` +
            `Run \`opencode auth login\` or set REMOTE_AGENT_PROVIDER to one of: ${Object.keys(auth).join(", ")}`,
        );
      }

      // Check expiry
      if (entry.expires && entry.expires > 0 && Date.now() > entry.expires) {
        throw new Error(
          `OAuth token for "${provider}" has expired. ` +
            `Run \`opencode auth login\` to refresh.`,
        );
      }

      return {
        payload: raw,
        format: "opencode-auth",
      };
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse OpenCode auth file at ${authPath}`);
      }
      throw err;
    }
  }

  throw new Error(
    "No authentication found. Options:\n" +
      "  - Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable\n" +
      "  - Set REMOTE_AGENT_AUTH_TOKEN environment variable\n" +
      "  - Run `opencode auth login` to authenticate via OAuth",
  );
}

/**
 * Map a provider name to the env var the container should receive.
 */
function providerToEnvVar(provider: string): string {
  const mapping: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    "github-copilot": "GITHUB_TOKEN",
    groq: "GROQ_API_KEY",
    gemini: "GEMINI_API_KEY",
  };
  return mapping[provider] ?? "ANTHROPIC_API_KEY";
}
