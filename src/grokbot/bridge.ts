import fs from "node:fs";
import path from "node:path";

export interface BridgeConfig {
  auth_header: string; // e.g. "Authorization" (sends "Bearer <key>") or any custom header (sends raw key)
  timeout_ms: number;
  user_cooldown_seconds: number;
  channel_cooldown_seconds: number;
  daily_event_cap: number;
  context_messages: number;
  context_max_chars: number;
  failed_log: string;
}

export interface GuardianEvent {
  type: "mention" | "flag";
  guild_id: string;
  channel_id: string;
  channel_name: string;
  message_id: string;
  message_url: string;
  author_id: string;
  author_name: string;
  content: string;
  context: string;
  prefilter_reason: string | null;
  sent_at: string;
}

/** Decides whether an event may be sent (cooldowns + daily cap). Pure, testable. */
export class EventGate {
  private user = new Map<string, number>();
  private channel = new Map<string, number>();
  private day = "";
  private count = 0;
  constructor(private cfg: Pick<BridgeConfig, "user_cooldown_seconds" | "channel_cooldown_seconds" | "daily_event_cap">) {}

  /** Flags bypass the channel cooldown (a spam wave in one channel must still surface) but share the user cooldown and cap. */
  allow(type: GuardianEvent["type"], userId: string, channelId: string, now = Date.now()): { ok: boolean; why?: string } {
    const d = new Date(now).toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.count = 0; }
    if (this.count >= this.cfg.daily_event_cap) return { ok: false, why: "daily cap" };
    const uk = `${type}:${userId}`;
    if (now - (this.user.get(uk) ?? -Infinity) < this.cfg.user_cooldown_seconds * 1000) return { ok: false, why: "user cooldown" };
    if (type === "mention" && now - (this.channel.get(channelId) ?? -Infinity) < this.cfg.channel_cooldown_seconds * 1000)
      return { ok: false, why: "channel cooldown" };
    this.user.set(uk, now);
    if (type === "mention") this.channel.set(channelId, now);
    this.count++;
    return { ok: true };
  }
  get sentToday(): number { return this.count; }
}

export function buildAuthHeaders(header: string, key: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (header.toLowerCase() === "authorization") h["Authorization"] = `Bearer ${key}`;
  else h[header] = key;
  return h;
}

export class GrokBotBridge {
  readonly gate: EventGate;
  constructor(private cfg: BridgeConfig, private url = process.env.GUARDIAN_WEBHOOK_URL, private key = process.env.GUARDIAN_WEBHOOK_KEY) {
    if (!url || !key) throw new Error("GUARDIAN_WEBHOOK_URL and GUARDIAN_WEBHOOK_KEY must be set for llm.provider: grokbot");
    this.gate = new EventGate(cfg);
  }

  /** One try, no retry. On failure the event is appended to a local JSONL log the routine can drain. */
  async send(ev: GuardianEvent): Promise<boolean> {
    try {
      const res = await fetch(this.url!, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildAuthHeaders(this.cfg.auth_header, this.key!) },
        body: JSON.stringify(ev),
        signal: AbortSignal.timeout(this.cfg.timeout_ms),
      });
      if (res.ok) return true;
      console.error(`[bridge] webhook HTTP ${res.status}`);
    } catch (err) {
      console.error("[bridge] webhook failed:", err instanceof Error ? err.message : err);
    }
    try {
      fs.mkdirSync(path.dirname(this.cfg.failed_log), { recursive: true });
      fs.appendFileSync(this.cfg.failed_log, JSON.stringify(ev) + "\n");
    } catch {}
    return false;
  }
}
