import type { TextChannel } from "discord.js";
import type { Config } from "./config.js";
import type { LlmClient } from "./llm/client.js";
import type { BudgetTracker } from "./budget.js";
import type { MemoryStore } from "./memory.js";

interface DayStats {
  messages: number;
  perChannel: Map<string, number>;
  joins: string[];
  flags: string[];
  botReplies: number;
}

function emptyStats(): DayStats {
  return { messages: 0, perChannel: new Map(), joins: [], flags: [], botReplies: 0 };
}

/** Collects lightweight daily activity stats and posts an LLM-written digest. */
export class DigestCollector {
  private stats = emptyStats();
  private lastPostedDay = "";

  constructor(
    private cfg: Config["digest"],
    private llm: LlmClient,
    private budget: BudgetTracker,
    private memory: MemoryStore,
  ) {}

  recordMessage(channelName: string) {
    this.stats.messages++;
    this.stats.perChannel.set(channelName, (this.stats.perChannel.get(channelName) ?? 0) + 1);
  }
  recordJoin(tag: string) {
    if (this.stats.joins.length < 50) this.stats.joins.push(tag);
  }
  recordFlag(summary: string) {
    if (this.stats.flags.length < 50) this.stats.flags.push(summary);
  }
  recordBotReply() {
    this.stats.botReplies++;
  }

  /** Call every minute; posts once per day at the configured UTC hour. */
  async tick(modChannel: TextChannel): Promise<void> {
    if (!this.cfg.enabled) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (!this.lastPostedDay) {
      try {
        const diary = this.memory.getRecentDiary(50);
        const matches = [...diary.matchAll(/- \[(\d{4}-\d{2}-\d{2})\] Day summary/g)];
        if (matches.length > 0) {
          this.lastPostedDay = matches[matches.length - 1][1];
        }
      } catch (err) {
        console.error("Failed to restore lastPostedDay for digest from diary:", err);
      }
    }

    // Catch-up: post any time from post_hour_utc onward, so a bot started
    // later in the day still delivers today's digest instead of skipping it.
    if (now.getUTCHours() < this.cfg.post_hour_utc) return;
    if (this.lastPostedDay === today) return;
    console.log(`digest: past post_hour_utc (${this.cfg.post_hour_utc} UTC). lastPostedDay: "${this.lastPostedDay}", today: "${today}".`);

    const s = this.stats;

    const channels = [...s.perChannel.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, n]) => `#${name}: ${n}`)
      .join(", ");

    const raw = `Date: ${today}
Total messages: ${s.messages}
Most active channels: ${channels || "none"}
New members (${s.joins.length}): ${s.joins.join(", ") || "none"}
Moderation flags (${s.flags.length}):
${s.flags.map((f) => `- ${f}`).join("\n") || "- none"}
Bot replies sent: ${s.botReplies}
LLM spend today: $${this.budget.spent.toFixed(3)}`;

    const result = await this.llm.complete(
      "digest",
      "You write the daily staff digest for a Discord server. Summarize the raw stats below in max 150 words. Plain tone, highlight anything needing moderator attention. No preamble.",
      [{ role: "user", content: raw }],
      512,
    );

    await modChannel.send({
      content: `**Daily digest — ${today}**\n${(result?.text ?? raw).slice(0, 1900)}`,
    });
    // Only mark the day done and drop the stats after a successful send, so a
    // transient failure is retried on the next tick without losing the day.
    this.lastPostedDay = today;
    this.stats = emptyStats();

    // The agent's own long-term memory of the day
    this.memory.appendDiary(
      `Day summary: ${s.messages} msgs, ${s.joins.length} joins, ${s.flags.length} flags, ${s.botReplies} replies by me.`,
    );
  }
}
