import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventGate, buildAuthHeaders, GrokBotBridge } from "../src/grokbot/bridge.js";
import { startLocalApi, checkSecret, LOCAL_COMMANDS } from "../src/grokbot/local-api.js";
import { TypingTracker } from "../src/grokbot/typing.js";

test("gate: user + channel cooldowns and daily cap", () => {
  const g = new EventGate({ user_cooldown_seconds: 60, channel_cooldown_seconds: 20, daily_event_cap: 3 });
  const t = Date.UTC(2026, 10, 1, 10);
  assert.ok(g.allow("mention", "u1", "c1", t).ok);
  assert.equal(g.allow("mention", "u1", "c2", t + 1000).why, "user cooldown");
  assert.equal(g.allow("mention", "u2", "c1", t + 1000).why, "channel cooldown");
  assert.ok(g.allow("flag", "u2", "c1", t + 1000).ok); // flags skip channel cooldown
  assert.ok(g.allow("mention", "u3", "c2", t + 2000).ok);
  assert.equal(g.allow("flag", "u4", "c3", t + 3000).why, "daily cap");
  assert.ok(g.allow("flag", "u4", "c3", t + 86_400_000).ok); // resets next UTC day
});

test("auth headers", () => {
  assert.deepEqual(buildAuthHeaders("Authorization", "k"), { Authorization: "Bearer k" });
  assert.deepEqual(buildAuthHeaders("X-Custom", "k"), { "X-Custom": "k" });
});

test("bridge posts JSON with auth to the webhook", async () => {
  let got: any;
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got = { h: req.headers, b: JSON.parse(b) }; res.end("ok"); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  const br = new GrokBotBridge({ auth_header: "Authorization", timeout_ms: 2000, user_cooldown_seconds: 0, channel_cooldown_seconds: 0, daily_event_cap: 5, context_messages: 0, context_max_chars: 200, failed_log: "/tmp/guardian-test-failed.jsonl" }, `http://127.0.0.1:${port}/hook`, "test-key");
  assert.equal(await br.send({ type: "flag", guild_id: "1", channel_id: "2", channel_name: "g", message_id: "3", message_url: "u", author_id: "4", author_name: "a", content: "free nitro", context: "", prefilter_reason: "free nitro", sent_at: "now" }), true);
  assert.equal(got.h.authorization, "Bearer test-key");
  assert.equal(got.b.type, "flag");
  srv.close();
});

test("local API: 127.0.0.1 only, secret required, no kick/ban", async () => {
  assert.ok(!LOCAL_COMMANDS.includes("ban" as any) && !LOCAL_COMMANDS.includes("kick" as any));
  assert.ok(LOCAL_COMMANDS.includes("announce"));
  assert.equal(checkSecret("abc", "abd"), false);
  const secret = "s".repeat(24);
  const srv = startLocalApi({ port: 0 as any, client: { user: { tag: "g#1" } } as any, actions: {} as any, typing: new TypingTracker(1), modChannel: () => null, maxTimeoutMinutes: 60, secret, allowedChannelIds: [] });
  await new Promise((r) => srv.once("listening", r));
  const addr = srv.address() as any;
  assert.equal(addr.address, "127.0.0.1");
  const call = (cmd: string, s?: string) => fetch(`http://127.0.0.1:${addr.port}/${cmd}`, { method: "POST", headers: s ? { "X-Guardian-Secret": s } : {}, body: "{}" });
  assert.equal((await call("health")).status, 401);
  assert.equal((await call("health", secret)).status, 200);
  assert.equal((await call("ban", secret)).status, 404);
  assert.equal((await call("kick", secret)).status, 404);
  srv.close();
});
