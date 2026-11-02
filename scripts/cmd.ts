// Usage: npm run cmd -- <command> key=value ...   (reads GUARDIAN_LOCAL_SECRET / GUARDIAN_LOCAL_PORT from .env)
import "dotenv/config";
import { LOCAL_COMMANDS } from "../src/grokbot/local-api.js";
const [cmd, ...kv] = process.argv.slice(2);
const allowed = new Set<string>(LOCAL_COMMANDS);
if (!cmd || !allowed.has(cmd)) {
  console.error(`usage: npm run cmd -- <${LOCAL_COMMANDS.join("|")}> key=value ...
  reply             channel_id=… content="…" [message_id=…]
  announce          channel_id=… content="…" [image=/absolute/path.png] [image_url=https://…] [mention_everyone=true]
  delete            channel_id=… message_id=… [reason="…"]
  timeout           channel_id=… user_id=… [minutes=10] [reason="…"] [message_id=…]
  flag-for-approval channel_id=… message_id=… reason="…"
  (kick/ban are only available via the staff-channel Approve buttons; announce never pings roles or users)`);
  process.exit(2);
}
const body = Object.fromEntries(kv.map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
const port = Number(process.env.GUARDIAN_LOCAL_PORT ?? 8787);
const res = await fetch(`http://127.0.0.1:${port}/${cmd}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Guardian-Secret": process.env.GUARDIAN_LOCAL_SECRET ?? "" },
  body: JSON.stringify(body),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
