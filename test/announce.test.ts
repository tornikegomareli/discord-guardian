import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { startLocalApi, LOCAL_COMMANDS } from "../src/grokbot/local-api.js";
import { TypingTracker } from "../src/grokbot/typing.js";
import {
  MAX_ANNOUNCE_IMAGE_BYTES,
  announceAllowedMentions,
  loadLocalAnnounceImage,
  loadRemoteAnnounceImage,
  mentionEveryoneRequested,
  readBodyCapped,
} from "../src/grokbot/announce.js";

const GUILD = "42";
const MOD = "200000000000000002";
const GENERAL = "200000000000000001";
const OTHER_GUILD = "200000000000000003";
const NO_MENTION = "200000000000000004";
const VOICE = "200000000000000005";
const OUTSIDE = "200000000000000006";
const THREAD = "200000000000000007";
const SECRET = "s".repeat(24);

test("announce mention flag and local image checks", async () => {
  assert.equal(mentionEveryoneRequested(true), true);
  assert.equal(mentionEveryoneRequested("true"), true);
  assert.equal(mentionEveryoneRequested(" TRUE "), true);
  assert.equal(mentionEveryoneRequested("false"), false);
  assert.equal(mentionEveryoneRequested("1"), false);
  assert.equal(mentionEveryoneRequested(undefined), false);
  assert.deepEqual(announceAllowedMentions(false), { parse: [] });
  assert.deepEqual(announceAllowedMentions(true), { parse: ["everyone"] });
  for (const mentions of [announceAllowedMentions(false), announceAllowedMentions(true)]) {
    assert.equal("users" in mentions, false);
    assert.equal("roles" in mentions, false);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "guardian-announce-"));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await writeFile(path.join(dir, "pic.png"), png);
    await writeFile(path.join(dir, "A.JPEG"), Buffer.from("jpeg"));
    await writeFile(path.join(dir, "anim.gif"), Buffer.from("GIF89a"));
    await writeFile(path.join(dir, "still.webp"), Buffer.from("RIFF"));
    await writeFile(path.join(dir, "empty.png"), Buffer.alloc(0));
    await mkdir(path.join(dir, "dir.png"));
    const big = path.join(dir, "big.png");
    const fh = await open(big, "w");
    await fh.truncate(MAX_ANNOUNCE_IMAGE_BYTES + 1);
    await fh.close();

    const loaded = await loadLocalAnnounceImage(path.join(dir, "pic.png"));
    assert.equal(loaded.name, "pic.png");
    assert.deepEqual(loaded.data, png);
    assert.equal((await loadLocalAnnounceImage(path.join(dir, "A.JPEG"))).name, "A.JPEG");
    assert.equal((await loadLocalAnnounceImage(path.join(dir, "anim.gif"))).name, "anim.gif");
    assert.equal((await loadLocalAnnounceImage(path.join(dir, "still.webp"))).name, "still.webp");
    await assert.rejects(loadLocalAnnounceImage(path.join(dir, "missing.png")), /image file not found/);
    await assert.rejects(loadLocalAnnounceImage(path.join(dir, "empty.png")), /image file is empty/);
    await assert.rejects(loadLocalAnnounceImage(path.join(dir, "dir.png")), /image file not found/);
    await assert.rejects(loadLocalAnnounceImage(big), /image too large \(max 8 MB\)/);
    await assert.rejects(loadLocalAnnounceImage("pic.png"), /image path must be absolute/);
    await assert.rejects(loadLocalAnnounceImage("/tmp/notes.txt"), /image must be png, jpg, gif, or webp/);
    await assert.rejects(loadLocalAnnounceImage("https://example.com/a.png"), /use image_url/);

    const tiny = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4]));
        controller.close();
      },
    });
    assert.deepEqual([...(await readBodyCapped(tiny, 4))], [1, 2, 3, 4]);
    const over = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    await assert.rejects(readBodyCapped(over, 4), /image too large/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("announce command: channels, mentions, image, and reply stays the same", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "guardian-announce-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const pngPath = path.join(dir, "poster.png");
  await writeFile(pngPath, png);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sent: Array<{ channelId: string; payload: any }> = [];
  const logs: string[] = [];
  const channels = new Map<string, any>();
  const add = (id: string, extra: { guildId?: string; mention?: boolean; type?: ChannelType; thread?: boolean } = {}) => {
    channels.set(id, {
      id,
      guildId: extra.guildId ?? GUILD,
      type: extra.type ?? ChannelType.GuildText,
      isThread: () => extra.thread === true,
      guild: { members: { me: { id: "bot" }, fetchMe: async () => ({ id: "bot" }) } },
      permissionsFor() {
        return {
          has(bit: bigint) {
            if (bit === PermissionFlagsBits.MentionEveryone) return extra.mention !== false;
            return true;
          },
        };
      },
      async send(payload: any) {
        sent.push({ channelId: id, payload });
        return { id: "900", url: `https://discord.com/channels/${extra.guildId ?? GUILD}/${id}/900` };
      },
    });
  };
  add(GENERAL);
  add(MOD);
  add(OTHER_GUILD, { guildId: "99" });
  add(NO_MENTION, { mention: false });
  add(VOICE, { type: ChannelType.GuildVoice });
  add(OUTSIDE);
  add(THREAD, { thread: true, type: ChannelType.PublicThread });

  const srv = startLocalApi({
    port: 0,
    client: { user: { tag: "g#1" }, channels: { fetch: async (id: string) => channels.get(id) ?? null } } as any,
    actions: {} as any,
    typing: new TypingTracker(1),
    modChannel: () => ({ id: MOD, guildId: GUILD }) as any,
    maxTimeoutMinutes: 60,
    secret: SECRET,
    allowedChannelIds: [MOD, GENERAL, OTHER_GUILD, NO_MENTION, VOICE, THREAD],
    log: (line) => logs.push(line),
  });
  await new Promise((r) => srv.once("listening", r));
  t.after(() => new Promise((r) => srv.close(() => r(undefined))));
  const port = (srv.address() as any).port;

  const post = async (cmd: string, body: unknown, auth = true) => {
    const res = await fetch(`http://127.0.0.1:${port}/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { "X-Guardian-Secret": SECRET } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as any };
  };

  assert.equal((await post("announce", { channel_id: GENERAL, content: "hi" }, false)).status, 401);

  const badId = await post("announce", { channel_id: "nope", content: "hi" });
  assert.equal(badId.status, 400);
  assert.equal(badId.json.error, "bad channel_id");

  const outside = await post("announce", { channel_id: OUTSIDE, content: "hi" });
  assert.equal(outside.status, 400);
  assert.equal(outside.json.error, "channel not allowed");

  const otherGuild = await post("announce", { channel_id: OTHER_GUILD, content: "hi" });
  assert.equal(otherGuild.status, 400);
  assert.equal(otherGuild.json.error, "channel not allowed");

  const voice = await post("announce", { channel_id: VOICE, content: "hi" });
  assert.equal(voice.status, 400);
  assert.equal(voice.json.error, "not a text channel");

  const empty = await post("announce", { channel_id: GENERAL, content: "   " });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, "content required");
  assert.equal(sent.length, 0);

  const missing = await post("announce", { channel_id: GENERAL, content: "hi", image: path.join(dir, "missing.png") });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, "image file not found");

  const tooBigPath = path.join(dir, "big.png");
  const fh = await open(tooBigPath, "w");
  await fh.truncate(MAX_ANNOUNCE_IMAGE_BYTES + 1);
  await fh.close();
  const tooBig = await post("announce", { channel_id: GENERAL, content: "hi", image: tooBigPath });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.json.error, "image too large (max 8 MB)");

  const noPerm = await post("announce", {
    channel_id: NO_MENTION,
    content: "@everyone tonight",
    mention_everyone: "true",
  });
  assert.equal(noPerm.status, 400);
  assert.equal(noPerm.json.error, "missing Mention Everyone permission");
  assert.equal(sent.length, 0);

  const quiet = await post("announce", {
    channel_id: GENERAL,
    content: "@everyone <@111111111111111111> <@&222222222222222222> hello",
    image: pngPath,
    mention_everyone: "false",
  });
  assert.equal(quiet.status, 200);
  assert.equal(quiet.json.message_id, "900");
  assert.equal(quiet.json.url, `https://discord.com/channels/${GUILD}/${GENERAL}/900`);
  assert.equal(sent[0].payload.content.includes("@everyone"), true);
  assert.deepEqual(sent[0].payload.allowedMentions, { parse: [] });
  assert.equal(sent[0].payload.files.length, 1);
  assert.equal(sent[0].payload.files[0].name, "poster.png");
  assert.deepEqual(sent[0].payload.files[0].attachment, png);
  assert.equal(logs.at(-1), `[announce] channel=${GENERAL} length=${sent[0].payload.content.length} image=poster.png everyone=false`);

  const loud = await post("announce", {
    channel_id: MOD,
    content: "@everyone @here <@111> <@&222>",
    mention_everyone: true,
  });
  assert.equal(loud.status, 200);
  assert.deepEqual(sent[1].payload.allowedMentions, { parse: ["everyone"] });
  assert.equal(sent[1].payload.files, undefined);
  assert.equal("users" in sent[1].payload.allowedMentions, false);
  assert.equal("roles" in sent[1].payload.allowedMentions, false);
  assert.equal(logs.at(-1), `[announce] channel=${MOD} length=${"@everyone @here <@111> <@&222>".length} image=none everyone=true`);

  const thread = await post("announce", { channel_id: THREAD, content: "in the thread" });
  assert.equal(thread.status, 200);
  assert.equal(sent[2].channelId, THREAD);

  const long = await post("announce", { channel_id: GENERAL, content: "x".repeat(2500) });
  assert.equal(long.status, 200);
  assert.equal(sent[3].payload.content.length, 2000);
  assert.match(logs.at(-1)!, /length=2000 image=none everyone=false/);

  const reply = await post("reply", {
    channel_id: OUTSIDE,
    content: "@everyone <@111> <@&222>",
    message_id: "333333333333333333",
    image: pngPath,
    mention_everyone: "true",
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { ok: true, message_id: "900" });
  assert.equal(sent[4].channelId, OUTSIDE);
  assert.deepEqual(sent[4].payload.allowedMentions, { parse: [], repliedUser: true });
  assert.equal(sent[4].payload.files, undefined);
  assert.deepEqual(sent[4].payload.reply, { messageReference: "333333333333333333", failIfNotExists: false });

  const unknown = await post("kick", {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /announce/);
  assert.doesNotMatch(unknown.json.error, /\bkick\b/);
  assert.ok(!LOCAL_COMMANDS.includes("ban" as any) && !LOCAL_COMMANDS.includes("kick" as any));

  const child = spawn(process.execPath, ["--import", "tsx", "scripts/cmd.ts", "announce", `channel_id=${GENERAL}`, "content=Movie night is Friday", `image=${pngPath}`, "mention_everyone=true"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, GUARDIAN_LOCAL_PORT: String(port), GUARDIAN_LOCAL_SECRET: SECRET },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  assert.equal(stderr, "");
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`^200 \\{"ok":true,"message_id":"900","url":"https://discord.com/channels/${GUILD}/${GENERAL}/900"\\}\\n$`));
  assert.equal(sent.at(-1)!.channelId, GENERAL);
  assert.equal(sent.at(-1)!.payload.content, "Movie night is Friday");
  assert.deepEqual(sent.at(-1)!.payload.allowedMentions, { parse: ["everyone"] });
  assert.equal(sent.at(-1)!.payload.files[0].name, "poster.png");
  assert.deepEqual(sent.at(-1)!.payload.files[0].attachment, png);
  assert.match(logs.at(-1)!, new RegExp(`\\[announce\\] channel=${GENERAL} length=21 image=poster\\.png everyone=true`));
});

test("announce image_url is attached when it is an image, and rejected otherwise", async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);
  const imgSrv = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/banner.png")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
      return;
    }
    if (url.startsWith("/octet.png")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(png);
      return;
    }
    if (url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html></html>");
      return;
    }
    if (url === "/missing") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("nope");
      return;
    }
    if (url === "/big") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(MAX_ANNOUNCE_IMAGE_BYTES + 1) });
      res.write(Buffer.alloc(1));
      req.on("close", () => res.destroy());
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((r) => imgSrv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => imgSrv.close(() => r(undefined))));
  const imgPort = (imgSrv.address() as any).port;
  const banner = `http://127.0.0.1:${imgPort}/banner.png?x=1`;

  const remote = await loadRemoteAnnounceImage(banner);
  assert.equal(remote.name, "banner.png");
  assert.deepEqual(remote.data, png);
  const octet = await loadRemoteAnnounceImage(`http://127.0.0.1:${imgPort}/octet.png`);
  assert.equal(octet.name, "octet.png");
  await assert.rejects(loadRemoteAnnounceImage(`http://127.0.0.1:${imgPort}/page`), /image_url must be png, jpg, gif, or webp/);
  await assert.rejects(loadRemoteAnnounceImage(`http://127.0.0.1:${imgPort}/missing`), /image_url fetch failed \(404\)/);
  await assert.rejects(loadRemoteAnnounceImage(`http://127.0.0.1:${imgPort}/big`), /image too large/);
  await assert.rejects(loadRemoteAnnounceImage("file:///etc/passwd"), /image_url must be http\(s\)/);
  await assert.rejects(loadRemoteAnnounceImage("not a url"), /bad image_url/);

  const sent: any[] = [];
  const logs: string[] = [];
  const ch = {
    id: GENERAL,
    guildId: GUILD,
    type: ChannelType.GuildText,
    isThread: () => false,
    async send(payload: any) {
      sent.push(payload);
      return { id: "901", url: `https://discord.com/channels/${GUILD}/${GENERAL}/901` };
    },
  };
  const srv = startLocalApi({
    port: 0,
    client: { user: { tag: "g#1" }, channels: { fetch: async () => ch } } as any,
    actions: {} as any,
    typing: new TypingTracker(1),
    modChannel: () => ({ id: MOD, guildId: GUILD }) as any,
    maxTimeoutMinutes: 60,
    secret: SECRET,
    allowedChannelIds: [GENERAL, MOD],
    log: (line) => logs.push(line),
  });
  await new Promise((r) => srv.once("listening", r));
  t.after(() => new Promise((r) => srv.close(() => r(undefined))));
  const port = (srv.address() as any).port;
  const dir = await mkdtemp(path.join(tmpdir(), "guardian-announce-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, "local.jpg");
  await writeFile(local, Buffer.from("jpg"));

  const res = await fetch(`http://127.0.0.1:${port}/announce`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Guardian-Secret": SECRET },
    body: JSON.stringify({ channel_id: GENERAL, content: "both", image: local, image_url: banner }),
  });
  assert.equal(res.status, 200);
  assert.equal(sent[0].files.length, 2);
  assert.equal(sent[0].files[0].name, "local.jpg");
  assert.deepEqual(sent[0].files[0].attachment, Buffer.from("jpg"));
  assert.equal(sent[0].files[1].name, "banner.png");
  assert.deepEqual(sent[0].files[1].attachment, png);
  assert.equal(logs[0], `[announce] channel=${GENERAL} length=4 image=local.jpg,banner.png everyone=false`);
});

test("CLI usage lists announce and does not offer kick or ban", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/cmd.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: process.env,
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  assert.equal(code, 2);
  assert.match(stderr, /reply\|announce\|delete\|timeout\|flag-for-approval\|health/);
  assert.match(stderr, /announce\s+channel_id=/);
  assert.match(stderr, /mention_everyone=true/);
  assert.doesNotMatch(stderr, /\|kick/);
  assert.doesNotMatch(stderr, /\|ban/);
});
