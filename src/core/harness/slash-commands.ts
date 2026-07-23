/**
 * Harness-local slash-command parsing (§6, §7.1).
 * Commands are plain text intercepted in the harness — never Telegraf
 * `bot.command` in the channel adapter.
 */

export type ParsedSlashCommand =
  | { kind: "start" }
  | { kind: "init" }
  | { kind: "init_cancel" };

export const START_HELP = [
  "Talk to me like a normal conversation — I remember durable personal details over time.",
  "",
  "Commands:",
  "  /init — short adaptive interview to capture useful facts about you",
  "  /init cancel — stop an in-progress init interview",
].join("\n");

/**
 * Parse a leading slash command. Normalizes `/cmd@BotName` → `/cmd`.
 * Returns null when the text is not a recognized harness command
 * (unknown `/foo` falls through to the normal reply path).
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const match = /^\/([^\s@]+)(?:@\S+)?(?:\s+(.*))?$/s.exec(trimmed);
  if (!match) return null;

  const cmd = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();

  if (cmd === "start") {
    return { kind: "start" };
  }

  if (cmd === "init") {
    if (args.toLowerCase() === "cancel") {
      return { kind: "init_cancel" };
    }
    // Bare /init (or /init with unrecognized args) starts/resumes.
    return { kind: "init" };
  }

  return null;
}
