import http from "node:http";
import crypto from "node:crypto";
import { ChannelType, type Client, type TextChannel } from "discord.js";
import type { ModerationActions } from "../moderation/actions.js";
import { buildButtons } from "../moderation/actions.js";
import type { TypingTracker } from "./typing.js";

/**
 * Local command interface for the Grok Bot. Bound to 127.0.0.1 only.
 * Deliberately exposes NO kick/ban: those exist only behind the staff-channel Approve buttons.
 */
export const LOCAL_COMMANDS = ["reply", "delete", "timeout", "flag-for-approval", "health"] as const;
const ID = /^\d{5,25}$/;

export function checkSecret(given: string | undefined, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startLocalApi(opts: {
  port: number; client: Client; actions: ModerationActions; typing: TypingTracker;
  modChannel: () => TextChannel | null; maxTimeoutMinutes: number; secret?: string;
}): http.Server {
  const secret = opts.secret ?? process.env.GUARDIAN_LOCAL_SECRET;
  if (!secret || secret.length < 16) throw new Error("GUARDIAN_LOCAL_SECRET must be set (16+ chars)");

  const textChannel = async (id: string) => {
    if (!ID.test(id)) throw new Error("bad channel_id");
    const ch = await opts.client.channels.fetch(id);
    if (!ch || (ch.type !== ChannelType.GuildText && !ch.isThread())) throw new Error("not a text channel");
    return ch as TextChannel;
  };

  const handlers: Record<string, (b: any) => Promise<unknown>> = {
    health: async () => ({ ok: true, user: opts.client.user?.tag ?? null }),
    reply: async (b) => {
      const ch = await textChannel(String(b.channel_id));
      const content = String(b.content ?? "").slice(0, 2000);
      if (!content) throw new Error("content required");
      opts.typing.stop(ch.id);
      const msg = await ch.send({
        content,
        reply: b.message_id && ID.test(String(b.message_id)) ? { messageReference: String(b.message_id), failIfNotExists: false } : undefined,
        allowedMentions: { parse: [], repliedUser: true },
      });
      return { ok: true, message_id: msg.id };
    },
    delete: async (b) => {
      const ch = await textChannel(String(b.channel_id));
      if (!ID.test(String(b.message_id))) throw new Error("bad message_id");
      return { ok: true, result: await opts.actions.execute("delete", { guildId: ch.guildId, channelId: ch.id, messageId: String(b.message_id), userId: "0" }, String(b.reason ?? "Grok Bot"), null) };
    },
    timeout: async (b) => {
      const ch = await textChannel(String(b.channel_id));
      if (!ID.test(String(b.user_id))) throw new Error("bad user_id");
      const minutes = Math.min(Math.max(1, Number(b.minutes) || 10), opts.maxTimeoutMinutes);
      return { ok: true, result: await opts.actions.execute("timeout", { guildId: ch.guildId, channelId: ch.id, messageId: String(b.message_id ?? "0"), userId: String(b.user_id) }, `Grok Bot: ${String(b.reason ?? "")}`.slice(0, 400), null, minutes) };
    },
    "flag-for-approval": async (b) => {
      const ch = await textChannel(String(b.channel_id));
      const mod = opts.modChannel();
      if (!mod) throw new Error("mod channel not ready");
      const msg = await ch.messages.fetch(String(b.message_id));
      await mod.send({
        content: `Flag from Grok Bot: ${String(b.reason ?? "").slice(0, 900)}\nAuthor: <@${msg.author.id}> (${msg.author.tag}) in <#${ch.id}>\n${msg.url}\n> ${msg.content.slice(0, 500).replace(/\n/g, "\n> ")}`,
        components: buildButtons({ channelId: ch.id, messageId: msg.id, userId: msg.author.id }),
        allowedMentions: { parse: [] },
      });
      opts.typing.stop(ch.id);
      return { ok: true };
    },
  };

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const cmd = (req.url ?? "").replace(/^\/+/, "").split("?")[0];
    if (req.method !== "POST") return send(405, { error: "POST only" });
    if (!checkSecret(req.headers["x-guardian-secret"] as string | undefined, secret)) return send(401, { error: "unauthorized" });
    const h = handlers[cmd];
    if (!h) return send(404, { error: `unknown command; allowed: ${LOCAL_COMMANDS.join(", ")}` });
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 20_000) req.destroy(); });
    req.on("end", async () => {
      try { send(200, await h(raw ? JSON.parse(raw) : {})); }
      catch (err) { send(400, { error: err instanceof Error ? err.message : String(err) }); }
    });
  });
  server.listen(opts.port, "127.0.0.1", () => console.log(`[local-api] listening on 127.0.0.1:${opts.port}`));
  return server;
}
