import { ChannelType, type Client, type TextChannel, type NewsChannel } from "discord.js";
import type { Config } from "./config.js";
import type { LlmClient } from "./llm/client.js";
import type { MemoryStore } from "./memory.js";
import { buildIdentity } from "./persona.js";

interface FeedItem {
  title: string;
  link: string;
}

/** Minimal RSS/Atom parser — good enough for Reddit and standard feeds. */
function parseFeed(xml: string, max: number): FeedItem[] {
  const items: FeedItem[] = [];
  // Atom: <entry><title>..</title><link href=".."/></entry>
  for (const entry of xml.split(/<entry[\s>]/).slice(1)) {
    const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
    const link = entry.match(/<link[^>]*href="([^"]+)"/)?.[1];
    if (title && link) items.push({ title: decode(title), link });
    if (items.length >= max) return items;
  }
  // RSS: <item><title>..</title><link>..</link></item>
  for (const item of xml.split(/<item[\s>]/).slice(1)) {
    const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
    const link = item.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1];
    if (title && link) items.push({ title: decode(title), link: link.trim() });
    if (items.length >= max) return items;
  }
  return items;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Daily movies and highlights roundup: pulls the configured feeds once a day, has the
 * agent pick what's genuinely interesting (focusing on videos) and post a categorized roundup.
 */
export class MoviesWatcher {
  private lastPostedDay = "";

  constructor(
    private cfg: Config["movies"],
    private fullCfg: Config,
    private llm: LlmClient,
    private memory: MemoryStore,
    private client: Client,
  ) {}

  /** Call every minute; posts once per day at the configured UTC hour. */
  async tick(): Promise<void> {
    if (!this.cfg.enabled || !this.cfg.channel_id) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (!this.lastPostedDay) {
      try {
        const diary = this.memory.getRecentDiary(50);
        const matches = [...diary.matchAll(/- \[(\d{4}-\d{2}-\d{2})\] Posted the daily movies roundup/g)];
        if (matches.length > 0) {
          this.lastPostedDay = matches[matches.length - 1][1];
        }
      } catch (err) {
        console.error("Failed to restore lastPostedDay from diary (movies):", err);
      }
    }

    if (now.getUTCHours() < this.cfg.post_hour_utc) return;
    if (this.lastPostedDay === today) return;
    console.log(`movies: past post_hour_utc (${this.cfg.post_hour_utc} UTC). lastPostedDay: "${this.lastPostedDay}", today: "${today}".`);

    const ch = await this.client.channels.fetch(this.cfg.channel_id);
    if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) {
      console.error("movies channel_id is not a text/announcement channel");
      return;
    }
    const channel = ch as TextChannel | NewsChannel;

    const items: FeedItem[] = [];
    for (const url of this.cfg.sources) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, {
          headers: { "user-agent": "mod-agent-for-discord/0.1 (Discord community bot)" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseFeed(await res.text(), this.cfg.max_items_per_source);
        console.log(`movies: ${url} → ${parsed.length} items`);
        items.push(...parsed);
      } catch (err) {
        console.error(`movies feed failed (${url}):`, err instanceof Error ? err.message : err);
      } finally {
        clearTimeout(timer);
      }
    }
    console.log(`movies: fetched ${items.length} items total from ${this.cfg.sources.length} feeds`);
    if (items.length === 0) return;

    const list = items
      .map((i, n) => `${n + 1}. ${i.title.slice(0, 150)}\n   ${i.link}`)
      .join("\n");

    const system = `${buildIdentity(this.fullCfg, this.memory)}

You are writing today's Movies and Highlights roundup for the video channel. Below are today's top items from the community feeds. Pick the 2-4 most interesting ones for this community, strictly focusing on VIDEOS. Do NOT include non-video content or pirated content.

Format: a short hyped intro line in your voice, then one bullet per picked video. For each video:
- Start with a category tag like [Demo], [Mac Tip], [Design], [Dev] or [News].
- Bold title.
- A one-line description/take of why it's interesting.
- The link on the same line or next line.
Max 180 words total.`;
  
    const result = await this.llm.complete("chat", system, [
      { role: "user", content: `Today's feed items:\n${list}` },
    ], 700);
    if (!result?.text) {
      console.log("movies: no LLM result (budget exhausted or API error)");
      return;
    }

    await channel.send({ content: result.text.slice(0, 2000) });
    this.lastPostedDay = today;
    this.memory.appendDiary(`Posted the daily movies roundup in #${channel.name}.`);
  }
}
