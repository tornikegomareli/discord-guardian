import type { Message } from "discord.js";
import type { Config } from "../config.js";

/**
 * Zero-cost first pass: only messages matching one of these signals are ever
 * sent to the LLM classifier. Everything else is ignored.
 */
export class Prefilter {
  private patterns: RegExp[];

  constructor(private cfg: Config["moderation"]) {
    this.patterns = cfg.prefilter_patterns.map((p) => new RegExp(p, "i"));
  }

  /** Returns the reason the message is suspicious, or null if clean. */
  match(message: Message): string | null {
    for (const re of this.patterns) {
      if (re.test(message.content)) return `pattern: ${re.source}`;
    }
    if (message.mentions.users.size > this.cfg.max_mentions) {
      return `mention spam: ${message.mentions.users.size} mentions`;
    }
    return null;
  }
}
