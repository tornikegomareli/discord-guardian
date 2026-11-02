import "dotenv/config";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Message,
  type TextChannel,
} from "discord.js";
import { loadConfig } from "./config.js";
import { BudgetTracker } from "./budget.js";
import { LlmClient } from "./llm/client.js";
import { Prefilter } from "./moderation/prefilter.js";
import { classify } from "./moderation/classifier.js";
import { escalate } from "./moderation/escalation.js";
import { postFlag } from "./moderation/flagger.js";
import { ModerationActions, shouldAutoAct } from "./moderation/actions.js";
import { ChatResponder } from "./interactions/chat.js";
import { Welcomer } from "./interactions/welcome.js";
import { Reactor } from "./interactions/reactions.js";
import { DigestCollector } from "./digest.js";
import { MemoryStore } from "./memory.js";
import { NewsWatcher } from "./news.js";
import { MoviesWatcher } from "./movies.js";
import { ProactiveEngine } from "./proactive.js";
import { buildIdentity } from "./persona.js";
import { GrokBotBridge, type GuardianEvent } from "./grokbot/bridge.js";
import { startLocalApi } from "./grokbot/local-api.js";
import { TypingTracker } from "./grokbot/typing.js";

const cfg = loadConfig();
const budget = new BudgetTracker(cfg.budget, cfg.llm.pricing);
const llm = new LlmClient(cfg.llm, budget);
const GROKBOT = cfg.llm.provider === "grokbot";
const bridge = GROKBOT ? new GrokBotBridge(cfg.grokbot) : null;
const typing = new TypingTracker(cfg.grokbot.typing_max_seconds);
const memory = new MemoryStore(cfg.memory.data_dir, cfg.memory.member_memory_max_chars);
const prefilter = new Prefilter(cfg.moderation);
const chat = new ChatResponder(cfg, llm, memory);
const welcomer = new Welcomer(cfg, llm, memory);
const reactor = new Reactor(cfg.reactions, llm, () => buildIdentity(cfg, memory));
const digest = new DigestCollector(cfg.digest, llm, budget, memory);

const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3 } as const;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

let modChannel: TextChannel | null = null;
const actions = new ModerationActions(cfg.moderation, client, () => modChannel);

async function verifyChannelPermissions(
  c: Client,
  channelId: string | undefined,
  purpose: string,
  required: bigint[] = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
) {
  if (!channelId) return;
  try {
    const ch = await c.channels.fetch(channelId);
    if (!ch) {
      console.warn(`[PermsCheck] Channel ${channelId} for ${purpose} not found.`);
      void modChannel?.send(`⚠️ [PermsCheck] Channel <#${channelId}> for **${purpose}** was not found.`);
      return;
    }
    if ('permissionsFor' in ch && ch.permissionsFor) {
      const perms = ch.permissionsFor(c.user!);
      if (!perms) {
        console.warn(`[PermsCheck] Could not resolve permissions for channel ${ch.id} (${purpose}).`);
        return;
      }
      const missing: string[] = [];
      for (const req of required) {
        if (!perms.has(req)) {
          const name = Object.keys(PermissionFlagsBits).find(
            (k) => (PermissionFlagsBits as any)[k] === req
          ) ?? req.toString();
          missing.push(name);
        }
      }
      if (missing.length > 0) {
        const msg = `⚠️ [PermsCheck] Bot is missing permissions in <#${ch.id}> (${purpose}): ${missing.join(", ")}`;
        console.warn(msg);
        void modChannel?.send(msg);
      } else {
        console.log(`[PermsCheck] Channel <#${ch.id}> (${purpose}) OK.`);
      }
    }
  } catch (err) {
    console.error(`[PermsCheck] Error verifying permissions for ${channelId} (${purpose}):`, err);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  const ch = await c.channels.fetch(cfg.server.mod_channel_id);
  if (!ch || ch.type !== ChannelType.GuildText) {
    throw new Error("mod_channel_id does not point to a text channel");
  }
  modChannel = ch;

  budget.onWarn = (spent, cap) =>
    void modChannel?.send(`⚠️ LLM budget at $${spent.toFixed(2)} of $${cap.toFixed(2)} daily cap.`);
  budget.onExhausted = (spent, cap) =>
    void modChannel?.send(
      `🛑 Daily LLM budget exhausted ($${spent.toFixed(2)}/$${cap.toFixed(2)}). ` +
        `Falling back to regex-only flagging until midnight UTC.`,
    );

  // Verify permissions for key channels
  await verifyChannelPermissions(c, cfg.server.mod_channel_id, "moderator logs");
  await verifyChannelPermissions(c, cfg.server.welcome_channel_id, "welcome messages");
  await verifyChannelPermissions(c, cfg.news.channel_id, "news updates");
  await verifyChannelPermissions(c, cfg.movies.channel_id, "movies and highlights");
  if (cfg.proactive.enabled) {
    await verifyChannelPermissions(c, cfg.proactive.channel_id, "proactive engine");
  }
  for (const gcId of cfg.server.general_channel_ids) {
    await verifyChannelPermissions(c, gcId, "general chat and reactions");
  }

  if (GROKBOT) {
    startLocalApi({
      port: cfg.grokbot.local_port,
      client: c,
      actions,
      typing,
      modChannel: () => modChannel,
      maxTimeoutMinutes: cfg.grokbot.max_timeout_minutes,
      allowedChannelIds: [cfg.server.mod_channel_id, ...cfg.server.general_channel_ids],
    });
    setInterval(() => { if (modChannel) void digest.tick(modChannel).catch(console.error); }, 60_000);
    return; // no LLM-driven news, movies or proactive posts in grokbot mode
  }
  const news = new NewsWatcher(cfg.news, cfg, llm, memory, c);
  const movies = new MoviesWatcher(cfg.movies, cfg, llm, memory, c);
  setInterval(() => {
    if (modChannel) void digest.tick(modChannel).catch(console.error);
    void news.tick().catch(console.error);
    void movies.tick().catch(console.error);
  }, 60_000);

  new ProactiveEngine(cfg.proactive, cfg, llm, memory, c).start();
});

async function fetchChannelContext(message: Message, botUserId: string): Promise<string> {
  const recent = await message.channel.messages.fetch({ limit: 10, before: message.id });
  return [...recent.values()]
    .reverse()
    .map((m) => `${m.author.id === botUserId ? "[bot]" : m.author.displayName}: ${m.content.slice(0, 200)}`)
    .join("\n");
}

async function sendEvent(type: GuardianEvent["type"], message: Message, prefilterReason: string | null): Promise<boolean> {
  if (!bridge) return false;
  const gate = bridge.gate.allow(type, message.author.id, message.channelId);
  if (!gate.ok) { console.log(`[bridge] ${type} from ${message.author.tag} skipped: ${gate.why}`); return false; }
  const n = cfg.grokbot.context_messages;
  const context = n === 0 ? "" : (await message.channel.messages.fetch({ limit: n, before: message.id }))
    .reverse().map((m) => `${m.author.id === client.user!.id ? "[guardian]" : m.author.displayName}: ${m.content.slice(0, 200)}`)
    .join("\n").slice(-cfg.grokbot.context_max_chars);
  if (type === "mention") typing.start(message.channel);
  const ok = await bridge.send({
    type, guild_id: message.guildId!, channel_id: message.channelId,
    channel_name: "name" in message.channel ? (message.channel.name ?? "") : "",
    message_id: message.id, message_url: message.url,
    author_id: message.author.id, author_name: message.author.tag,
    content: message.content.slice(0, 1500), context, prefilter_reason: prefilterReason,
    sent_at: new Date().toISOString(),
  });
  if (!ok) typing.stop(message.channelId);
  return ok;
}

async function handleModeration(message: Message, reason: string): Promise<boolean> {
  if (!modChannel) return false;
  const channelName = "name" in message.channel ? (message.channel.name ?? "?") : "?";

  const verdict = await classify(llm, message.content, message.author.tag, channelName);

  // Classifier confidently says clean -> drop the pre-filter false positive quietly
  if (verdict && verdict.category === "ok" && verdict.confidence >= 0.8) return false;

  let escalationReport: string | null = null;
  if (
    verdict &&
    SEVERITY_RANK[verdict.severity] >= SEVERITY_RANK[cfg.moderation.escalate_severity]
  ) {
    const context = await fetchChannelContext(message, client.user!.id);
    escalationReport = await escalate(llm, verdict, message.content, message.author.tag, context);
  }

  const mode = cfg.moderation.mode;
  let autoOutcome: string | null = null;
  if (shouldAutoAct(cfg.moderation, verdict)) {
    const t = { guildId: message.guildId!, channelId: message.channelId, messageId: message.id, userId: message.author.id };
    const results: string[] = [];
    for (const a of cfg.moderation.auto_actions) {
      results.push(await actions.execute(a, t, `${verdict!.category} (conf ${verdict!.confidence}): ${verdict!.reason}`, null));
    }
    autoOutcome = results.join("; ");
  }
  await postFlag(modChannel, message, reason, verdict, escalationReport, mode !== "recommend" && !autoOutcome, autoOutcome);
  digest.recordFlag(
    `${message.author.tag} in #${channelName}: ${verdict ? `${verdict.category}/${verdict.severity}` : "prefilter"} — ${(verdict?.reason ?? reason).slice(0, 100)}`,
  );
  return true;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;
  if (message.channelId === cfg.server.mod_channel_id) return; // never process staff channel

  // Developer command: Test welcome logic
  if (message.content === "!testwelcome" && message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    try {
      if (cfg.interactions.welcome_enabled && cfg.server.welcome_channel_id) {
        const ch = await message.guild.channels.fetch(cfg.server.welcome_channel_id);
        if (ch?.type === ChannelType.GuildText) {
          await welcomer.welcome(message.member, ch);
          await message.reply("Simulated welcome message sent!");
        } else {
          await message.reply("Welcome channel is not a text channel or not found.");
        }
      } else {
        await message.reply("Welcome is disabled or welcome_channel_id is not set in config.");
      }
    } catch (err) {
      console.error("!testwelcome command error:", err);
      await message.reply(`Error running test: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const channelName = "name" in message.channel ? (message.channel.name ?? "?") : "?";
  digest.recordMessage(channelName);

  try {
    // Moderation first: a suspicious message gets flagged, not answered
    const reason = prefilter.match(message);
    if (GROKBOT) {
      const isMention = message.mentions.users.has(client.user!.id) || message.mentions.repliedUser?.id === client.user!.id;
      if (reason) {
        // Free path: post the flag with Approve/Reject buttons right away, and let the Grok Bot add judgment.
        if (modChannel) await postFlag(modChannel, message, reason, null, null, cfg.moderation.mode !== "recommend");
        digest.recordFlag(`${message.author.tag} in #${channelName}: prefilter — ${reason.slice(0, 100)}`);
        await sendEvent("flag", message, reason);
      } else if (isMention && cfg.interactions.respond_to_mentions) {
        await sendEvent("mention", message, null);
      }
      return;
    }
    if (reason) {
      const flagged = await handleModeration(message, reason);
      if (flagged) return;
    }

    if (chat.shouldRespond(message, client.user!.id)) {
      await chat.respond(message, client.user!.id);
      digest.recordBotReply();
      return;
    }

    // Occasionally react with an emoji in the general channels
    if (cfg.server.general_channel_ids.includes(message.channelId)) {
      await reactor.maybeReact(message);
    }
  } catch (err) {
    console.error("messageCreate handler error:", err);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || i.channelId !== cfg.server.mod_channel_id) return;
  try {
    await actions.handleButton(i);
  } catch (err) {
    console.error("button handler error:", err);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  digest.recordJoin(member.user.tag);
  if (!cfg.interactions.welcome_enabled || !cfg.server.welcome_channel_id) return;
  try {
    const ch = await member.guild.channels.fetch(cfg.server.welcome_channel_id);
    if (GROKBOT) return; // no LLM welcomes in grokbot mode
    if (ch?.type === ChannelType.GuildText) await welcomer.welcome(member, ch);
  } catch (err) {
    console.error("guildMemberAdd handler error:", err);
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN not set");
void client.login(token);
