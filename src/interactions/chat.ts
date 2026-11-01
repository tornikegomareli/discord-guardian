import type { Message } from "discord.js";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import type { ChatMessage } from "../llm/provider.js";
import { extractJson } from "../llm/provider.js";
import type { MemoryStore } from "../memory.js";
import { buildIdentity } from "../persona.js";

/**
 * Member-facing chat: replies to @mentions/replies anywhere, and to plain
 * questions in the configured general channels. Cooldowns keep costs bounded.
 * The agent remembers members across conversations via the MemoryStore.
 */
export class ChatResponder {
  private userLastReply = new Map<string, number>();
  private channelLastReply = new Map<string, number>();

  constructor(
    private cfg: Config,
    private llm: LlmClient,
    private memory: MemoryStore,
  ) {}

  private buildSystem(userId: string, displayName: string): string {
    const faq = Object.entries(this.cfg.interactions.faq)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");
    const memberNotes = this.memory.getMember(userId);
    return `${buildIdentity(this.cfg, this.memory)}

KNOWN FACTS (prefer these over your own knowledge when relevant):
${faq || "- (none)"}

WHAT YOU REMEMBER ABOUT ${displayName}:
${memberNotes || "(first time you talk to them, as far as you recall)"}

Rules:
- Keep replies short (2-4 sentences), Discord-casual, no markdown headers.
- Use what you remember about people naturally, like a friend would. Don't recite their file.
- If you don't know something, say so. Never invent features, prices, release dates, version numbers or links. If the answer is not in KNOWN FACTS and you are unsure, say you don't know and point them to #feedback or tag the team. Never ask for passwords, API keys or payment details, and remind people the team never DMs first asking for them.`;
  }

  /** Decides for free (no LLM call) whether this message deserves a reply. */
  shouldRespond(message: Message, botUserId: string): boolean {
    const icfg = this.cfg.interactions;
    const now = Date.now();
    const isMention =
      icfg.respond_to_mentions &&
      (message.mentions.users.has(botUserId) ||
        message.mentions.repliedUser?.id === botUserId);

    const isGeneralQuestion =
      icfg.respond_in_general &&
      this.cfg.server.general_channel_ids.includes(message.channelId) &&
      /\?\s*$/.test(message.content) &&
      message.content.length > 10 &&
      now - (this.channelLastReply.get(message.channelId) ?? 0) >
        icfg.channel_cooldown_seconds * 1000;

    if (!isMention && !isGeneralQuestion) return false;

    // Mentions bypass the channel cooldown but respect the per-user one.
    const lastUser = this.userLastReply.get(message.author.id) ?? 0;
    return now - lastUser > icfg.user_cooldown_seconds * 1000;
  }

  async respond(message: Message, botUserId: string): Promise<void> {
    // Recent channel context so answers fit the ongoing conversation
    const recent = await message.channel.messages.fetch({
      limit: this.cfg.interactions.context_messages,
      before: message.id,
    });
    const context: ChatMessage[] = [...recent.values()]
      .reverse()
      .filter((m) => m.content)
      .map((m) => ({
        role: m.author.id === botUserId ? ("assistant" as const) : ("user" as const),
        content: `${m.author.id === botUserId ? "" : m.author.displayName + ": "}${m.content.slice(0, 400)}`,
      }));
    context.push({
      role: "user",
      content: `${message.author.displayName}: ${message.content.slice(0, 800)}`,
    });

    // Merge consecutive same-role messages (Anthropic requires alternation)
    const merged: ChatMessage[] = [];
    for (const m of context) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += `\n${m.content}`;
      else merged.push({ ...m });
    }
    if (merged[0]?.role === "assistant") merged.shift();

    const system = this.buildSystem(message.author.id, message.author.displayName);
    const result = await this.llm.complete("chat", system, merged, 512);
    if (!result?.text) return;

    this.userLastReply.set(message.author.id, Date.now());
    this.channelLastReply.set(message.channelId, Date.now());
    await message.reply({ content: result.text.slice(0, 2000), allowedMentions: { repliedUser: true } });

    if (this.cfg.memory.learn_about_members) {
      await this.learn(message).catch(() => {});
    }
  }

  /** Post-conversation: cheap model decides if the exchange revealed anything worth remembering. */
  private async learn(message: Message): Promise<void> {
    const result = await this.llm.complete(
      "classifier",
      `You maintain member notes for a Discord community agent. Given a member's message, decide if it reveals something durable and worth remembering about them (interests, expertise, projects, preferences, milestones). Ignore small talk.
Respond with ONLY JSON: {"remember": "one short fact" or null}`,
      [{ role: "user", content: `${message.author.displayName}: ${message.content.slice(0, 600)}` }],
      128,
    );
    if (!result) return;
    try {
      const parsed = extractJson(result.text) as { remember?: string | null };
      if (parsed.remember) {
        this.memory.rememberMember(message.author.id, message.author.displayName, parsed.remember);
      }
    } catch {
      // no note this time
    }
  }
}
