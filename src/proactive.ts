import { ChannelType, type Client, type TextChannel } from "discord.js";
import type { Config } from "./config.js";
import type { LlmClient } from "./llm/client.js";
import type { MemoryStore } from "./memory.js";
import { buildIdentity } from "./persona.js";

/**
 * Spontaneous engagement: at random intervals (within active hours, capped
 * per day) the agent reads the recent conversation and decides to post
 * something — a discussion starter, countdown hype, a comment on what's
 * happening. If the channel doesn't need it, it stays silent.
 */
export class ProactiveEngine {
  private postsToday = 0;
  private day = "";

  constructor(
    private cfg: Config["proactive"],
    private fullCfg: Config,
    private llm: LlmClient,
    private memory: MemoryStore,
    private client: Client,
  ) {}

  start(): void {
    if (!this.cfg.enabled || !this.cfg.channel_id) return;
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const { min_hours_between: min, max_hours_between: max } = this.cfg;
    const hours = min + Math.random() * Math.max(0, max - min);
    setTimeout(() => {
      void this.fire()
        .catch((err) => console.error("proactive error:", err))
        .finally(() => this.scheduleNext());
    }, hours * 3_600_000);
  }

  private rollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.postsToday = 0;
    }
  }

  private async fire(): Promise<void> {
    this.rollover();
    if (this.postsToday >= this.cfg.daily_max) return;
    const hour = new Date().getUTCHours();
    const [from, to] = this.cfg.active_hours_utc;
    const inWindow = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
    if (!inWindow) return;

    const ch = await this.client.channels.fetch(this.cfg.channel_id);
    if (!ch || ch.type !== ChannelType.GuildText) return;
    const channel = ch as TextChannel;

    const recent = await channel.messages.fetch({ limit: 15 });
    const transcript = [...recent.values()]
      .reverse()
      .filter((m) => m.content)
      .map((m) => `${m.author.bot ? "[you]" : m.author.displayName}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const system = `${buildIdentity(this.fullCfg, this.memory)}

You are considering posting something spontaneous in #${channel.name}. Recent conversation:
${transcript || "(channel is quiet)"}

Decide: is there something genuinely worth saying? Good reasons: ask members what they are working on or what they would like next, share a tip from KNOWN FACTS, pick up on something interesting members said recently, welcome activity after silence. Bad reasons: repeating yourself (check your diary), interrupting an active conversation between members, posting filler.

Respond with ONLY a JSON object:
{"post": true/false, "message": "the message to send (casual, max 3 sentences, no headers)", "reason": "why"}`;

    const result = await this.llm.complete("chat", system, [
      { role: "user", content: "Decide now." },
    ], 512);
    if (!result) return;

    try {
      const { extractJson } = await import("./llm/provider.js");
      const decision = extractJson(result.text) as { post?: boolean; message?: string };
      if (decision.post && decision.message) {
        await channel.send({ content: decision.message.slice(0, 2000) });
        this.postsToday++;
        this.memory.appendDiary(`Posted in #${channel.name}: ${decision.message.slice(0, 120)}`);
      }
    } catch {
      // Unparseable decision -> skip this round
    }
  }
}
