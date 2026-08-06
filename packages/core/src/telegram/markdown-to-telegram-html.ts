/**
 * Markdown → Telegram Bot API HTML (`parse_mode: "HTML"`).
 *
 * Telegram only allows a small tag set (`b`/`strong`, `i`/`em`, `u`/`ins`,
 * `s`/`strike`/`del`, spoiler spans, `a`, `tg-emoji`, `code`, `pre`,
 * `blockquote`). Block tags from a normal markdown→HTML converter (`p`,
 * `ul`/`ol`/`li`, `h1`–`h6`, `br`, tables, raw HTML) cause 400 parse errors.
 *
 * Uses a dedicated `Marked` instance with a custom renderer so we keep
 * inline formatting while flattening unsupported blocks to plain text.
 */

import { Marked } from "marked";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const telegramMarked = new Marked();

telegramMarked.use({
  renderer: {
    paragraph({ tokens }) {
      return `${this.parser.parseInline(tokens)}\n\n`;
    },

    list(token) {
      const start = typeof token.start === "number" ? token.start : 1;
      const lines = token.items.map((item, i) => {
        const prefix = token.ordered ? `${start + i}. ` : "- ";
        let body = this.listitem(item).replace(/\n+$/, "");
        // Indent continuation / nested lines under the item prefix.
        body = body.replace(/\n/g, "\n  ");
        return `${prefix}${body}`;
      });
      return `${lines.join("\n")}\n\n`;
    },

    listitem(item) {
      // Parse tokens one-by-one so nested lists get a newline after prior
      // text (tight items otherwise concatenate `"outer"` + `"- nested"`).
      let out = "";
      for (const token of item.tokens) {
        if (token.type === "space") continue;
        const piece = this.parser.parse([token]).replace(/\n+$/, "");
        if (!piece) continue;
        if (out.length === 0 || token.type === "checkbox" || out.endsWith(" ")) {
          out += piece;
        } else {
          out += `\n${piece}`;
        }
      }
      return out;
    },

    checkbox({ checked }) {
      return checked ? "☑ " : "☐ ";
    },

    heading({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>\n\n`;
    },

    br() {
      return "\n";
    },

    hr() {
      return "———\n\n";
    },

    html({ text }) {
      return escapeHtml(text);
    },

    table(token) {
      const header = token.header
        .map((cell) => this.parser.parseInline(cell.tokens))
        .join(" | ");
      const rows = token.rows.map((row) =>
        row.map((cell) => this.parser.parseInline(cell.tokens)).join(" | "),
      );
      return `${[header, ...rows].join("\n")}\n\n`;
    },

    image({ text }) {
      return escapeHtml(text || "");
    },

    blockquote({ tokens }) {
      const body = this.parser.parse(tokens).replace(/\n+$/, "");
      return `<blockquote>${body}</blockquote>\n`;
    },

    // strong / em / codespan / del / link / code / text: marked defaults are
    // already Telegram-legal (`strong`/`em`/`del`/`code`/`pre`/`a`).
  },
});

/**
 * Convert markdown (or plain text) to Telegram-safe HTML.
 * All outbound `sendMessage` text should go through this before `parse_mode: "HTML"`.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const html = telegramMarked.parse(markdown, { async: false });
  if (typeof html !== "string") {
    throw new Error("markdownToTelegramHtml: unexpected async marked output");
  }
  return html.replace(/\n+$/, "");
}
