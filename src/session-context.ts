import { putObject } from "./aws/s3.js";
import type { RemoteAgentConfig } from "./config.js";

const MAX_CONTEXT_CHARS = 50_000;
const MAX_RECENT_EXCHANGES = 10;

/**
 * Represents a message exchange (user prompt + assistant response).
 */
interface MessageExchange {
  userText: string;
  assistantText: string;
}

/**
 * Extract session context from the current OpenCode session.
 *
 * Strategy:
 * 1. Fetch all messages via the SDK client
 * 2. Look for the most recent compaction marker
 * 3. If compaction exists: use messages after it (the summary + subsequent conversation)
 * 4. If no compaction: take the last N exchanges
 * 5. Format as a condensed conversation summary
 */
export async function extractSessionContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  sessionID: string,
): Promise<string> {
  // Fetch session metadata
  const sessionResp = await client.session.get({
    path: { id: sessionID },
  });
  const session = sessionResp.data;

  // Fetch all messages with their parts
  const messagesResp = await client.session.messages({
    path: { id: sessionID },
  });
  const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> =
    messagesResp.data ?? [];

  if (messages.length === 0) {
    return formatContext(session, []);
  }

  // Find the most recent compaction marker
  let compactionIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const hasCompaction = msg.parts.some(
      (p) => p.type === "compaction",
    );
    if (hasCompaction) {
      compactionIndex = i;
      break;
    }
  }

  // Determine which messages to include
  let relevantMessages: typeof messages;
  if (compactionIndex >= 0) {
    // Include everything from the compaction point onwards
    relevantMessages = messages.slice(compactionIndex);
  } else {
    // No compaction: take the last N message pairs
    // Each exchange is a user message + assistant message, so take last N*2
    const startIndex = Math.max(0, messages.length - MAX_RECENT_EXCHANGES * 2);
    relevantMessages = messages.slice(startIndex);
  }

  // Build exchanges from the relevant messages
  const exchanges: MessageExchange[] = [];

  for (const msg of relevantMessages) {
    const role = msg.info.role as string;
    const textParts = msg.parts
      .filter((p) => p.type === "text" && !p.ignored)
      .map((p) => (p as { text: string }).text)
      .filter(Boolean);

    const combinedText = textParts.join("\n").trim();
    if (!combinedText) continue;

    if (role === "user") {
      exchanges.push({ userText: combinedText, assistantText: "" });
    } else if (role === "assistant" && exchanges.length > 0) {
      // Attach to the most recent exchange
      const lastExchange = exchanges[exchanges.length - 1];
      if (lastExchange.assistantText) {
        // Multiple assistant messages for one user message — append
        lastExchange.assistantText += "\n" + combinedText;
      } else {
        lastExchange.assistantText = combinedText;
      }
    }
  }

  return formatContext(session, exchanges);
}

/**
 * Format session metadata and exchanges into a structured context string.
 */
function formatContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
  exchanges: MessageExchange[],
): string {
  const lines: string[] = [];

  // Session metadata
  if (session) {
    lines.push(`Session: "${session.title ?? "Untitled"}"`);
    lines.push(`Directory: ${session.directory ?? "unknown"}`);
    const created = session.time?.created
      ? new Date(session.time.created).toISOString()
      : "unknown";
    lines.push(`Started: ${created}`);
    lines.push("");
  }

  if (exchanges.length === 0) {
    lines.push("(No conversation history available)");
    return lines.join("\n");
  }

  // Format exchanges
  lines.push("Conversation so far:");
  lines.push("");

  let totalChars = lines.join("\n").length;

  for (const exchange of exchanges) {
    const userBlock = `[User]: ${exchange.userText}`;
    const assistantBlock = exchange.assistantText
      ? `[Assistant]: ${exchange.assistantText}`
      : "";

    const blockSize = userBlock.length + assistantBlock.length + 4; // newlines

    // Truncate if we'd exceed the limit
    if (totalChars + blockSize > MAX_CONTEXT_CHARS) {
      // Try to fit a truncated version
      const remaining = MAX_CONTEXT_CHARS - totalChars - 100;
      if (remaining > 200) {
        const truncatedUser = exchange.userText.slice(0, remaining / 2);
        const truncatedAssistant = exchange.assistantText.slice(
          0,
          remaining / 2,
        );
        lines.push(`[User]: ${truncatedUser}...`);
        if (truncatedAssistant) {
          lines.push(`[Assistant]: ${truncatedAssistant}...`);
        }
      }
      lines.push("", "(earlier conversation truncated for brevity)");
      break;
    }

    lines.push(userBlock);
    if (assistantBlock) {
      lines.push(assistantBlock);
    }
    lines.push("");
    totalChars += blockSize;
  }

  return lines.join("\n");
}

/**
 * Build the full prompt for the remote OpenCode agent,
 * combining session context with the user's task prompt.
 */
export function buildRemotePrompt(
  sessionContext: string,
  userPrompt: string,
): string {
  return [
    `<session-context>`,
    `You are continuing a coding session that was started locally. Here is the context of what happened so far:`,
    ``,
    sessionContext,
    `</session-context>`,
    ``,
    `<task>`,
    userPrompt,
    `</task>`,
    ``,
    `<instructions>`,
    `- Your workspace at /workspace/repo contains the exact codebase state from the local session, including any uncommitted changes.`,
    `- Complete the task described above.`,
    `- All file changes you make will be automatically captured as a git patch and sent back to the user.`,
    `- Focus on making the requested changes. Be thorough and complete.`,
    `- If the task requires running tests or builds, do so and report the results.`,
    `</instructions>`,
  ].join("\n");
}

/**
 * Upload the built prompt to S3 so the container can download it.
 * This avoids the 8KB ECS overrides limit for environment variables.
 *
 * @returns The S3 key where the prompt was uploaded.
 */
export async function uploadSessionContext(
  config: RemoteAgentConfig,
  taskId: string,
  prompt: string,
): Promise<string> {
  const key = `tasks/${taskId}/prompt.txt`;
  await putObject(config, key, prompt, "text/plain");
  return key;
}
