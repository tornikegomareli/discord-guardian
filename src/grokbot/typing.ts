import type { TextBasedChannel } from "discord.js";

/** Keeps Discord's "Guardian is typing…" indicator alive while the Grok Bot works, up to max_seconds. */
export class TypingTracker {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private maxSeconds: number) {}
  start(ch: TextBasedChannel): void {
    if (!("sendTyping" in ch)) return;
    this.stop(ch.id);
    const started = Date.now();
    const tick = () => void (ch as any).sendTyping().catch(() => {});
    tick();
    const t = setInterval(() => (Date.now() - started > this.maxSeconds * 1000 ? this.stop(ch.id) : tick()), 8000);
    this.timers.set(ch.id, t);
  }
  stop(channelId: string): void {
    const t = this.timers.get(channelId);
    if (t) clearInterval(t);
    this.timers.delete(channelId);
  }
}
