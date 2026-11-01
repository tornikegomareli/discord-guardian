import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import type { Verdict } from "./classifier.js";

export type ModAction = "delete" | "timeout" | "kick" | "ban";
export const MOD_ACTIONS: ModAction[] = ["delete", "timeout", "kick", "ban"];

export interface ActionConfig {
  mode: "recommend" | "approve" | "auto";
  timeout_minutes: number;
  ban_delete_message_seconds: number;
  auto_categories: string[];
  auto_min_confidence: number;
  auto_actions: ModAction[];
  mod_log_channel_id: string;
  approver_role_ids: string[];
}

export interface Target {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
}

const PREFIX = "gmod";

/** customId: gmod:<action|reject>:<channelId>:<messageId>:<userId> (well under the 100-char limit). */
export function encodeId(action: ModAction | "reject", t: Omit<Target, "guildId">): string {
  return [PREFIX, action, t.channelId, t.messageId, t.userId].join(":");
}

export function decodeId(id: string): { action: ModAction | "reject"; t: Omit<Target, "guildId"> } | null {
  const p = id.split(":");
  if (p.length !== 5 || p[0] !== PREFIX) return null;
  const action = p[1] as ModAction | "reject";
  if (action !== "reject" && !MOD_ACTIONS.includes(action)) return null;
  if (![p[2], p[3], p[4]].every((s) => /^\d{5,25}$/.test(s))) return null;
  return { action, t: { channelId: p[2], messageId: p[3], userId: p[4] } };
}

/** Auto only for confident, high-severity scam/spam (configurable categories). */
export function shouldAutoAct(cfg: ActionConfig, v: Verdict | null): boolean {
  return (
    cfg.mode === "auto" &&
    !!v &&
    v.severity === "high" &&
    cfg.auto_categories.includes(v.category) &&
    v.confidence >= cfg.auto_min_confidence
  );
}

export function buildButtons(t: Omit<Target, "guildId">): ActionRowBuilder<ButtonBuilder>[] {
  const b = (a: ModAction | "reject", label: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(encodeId(a, t)).setLabel(label).setStyle(style);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b("delete", "Approve: delete", ButtonStyle.Secondary),
      b("timeout", "Approve: timeout", ButtonStyle.Primary),
      b("kick", "Approve: kick", ButtonStyle.Danger),
      b("ban", "Approve: ban", ButtonStyle.Danger),
      b("reject", "Reject", ButtonStyle.Success),
    ),
  ];
}

const NEEDED: Record<ModAction, bigint> = {
  delete: PermissionFlagsBits.ManageMessages,
  timeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

/** Returns an error string if `actor` may not apply `action` to `target`, else null. */
export function hierarchyError(action: ModAction, actor: GuildMember, target: GuildMember | null): string | null {
  if (!actor.permissions.has(NEEDED[action])) return `${actor.user.tag} lacks the ${action} permission`;
  if (!target || action === "delete") return null;
  if (target.id === target.guild.ownerId) return "target is the server owner";
  if (target.id === actor.id) return "cannot act on self";
  if (actor.id !== actor.guild.ownerId && target.roles.highest.comparePositionTo(actor.roles.highest) >= 0)
    return `target's top role is not below ${actor.user.tag}'s`;
  return null;
}

export class ModerationActions {
  constructor(private cfg: ActionConfig, private client: Client, private fallbackLog: () => TextChannel | null) {}

  private async log(text: string): Promise<void> {
    console.log(`[mod-log] ${text}`);
    try {
      const id = this.cfg.mod_log_channel_id;
      const ch = id ? await this.client.channels.fetch(id) : this.fallbackLog();
      if (ch && "send" in ch) await (ch as TextChannel).send({ content: text, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error("mod-log send failed:", err);
    }
  }

  /** Executes one action as the bot after hierarchy checks for both the approver (if any) and the bot. */
  async execute(action: ModAction, t: Target, reason: string, approver: GuildMember | null, minutes = this.cfg.timeout_minutes): Promise<string> {
    const guild = await this.client.guilds.fetch(t.guildId);
    const me = await guild.members.fetchMe();
    const target = await guild.members.fetch(t.userId).catch(() => null);
    for (const actor of approver ? [approver, me] : [me]) {
      const err = hierarchyError(action, actor, target);
      if (err) {
        await this.log(`⛔ ${action} on <@${t.userId}> blocked: ${err}. Reason: ${reason}`);
        return `Blocked: ${err}`;
      }
    }
    const audit = `${approver ? `Approved by ${approver.user.tag}` : "Auto"}: ${reason}`.slice(0, 500);
    try {
      if (action === "delete") {
        const ch = await guild.channels.fetch(t.channelId);
        if (ch?.isTextBased()) await (await ch.messages.fetch(t.messageId)).delete();
      } else if (action === "timeout") {
        if (!target) throw new Error("member not in server");
        await target.timeout(minutes * 60_000, audit);
      } else if (action === "kick") {
        if (!target) throw new Error("member not in server");
        await target.kick(audit);
      } else {
        await guild.members.ban(t.userId, { reason: audit, deleteMessageSeconds: this.cfg.ban_delete_message_seconds });
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await this.log(`❌ ${action} on <@${t.userId}> failed: ${m}`);
      return `Failed: ${m}`;
    }
    const extra = action === "timeout" ? ` (${minutes} min)` : "";
    await this.log(`✅ ${action}${extra} on <@${t.userId}> — ${audit} — msg ${t.channelId}/${t.messageId}`);
    return `Done: ${action}${extra}`;
  }

  async handleButton(i: ButtonInteraction): Promise<boolean> {
    const parsed = decodeId(i.customId);
    if (!parsed || !i.inCachedGuild()) return false;
    const member = i.member;
    const allowed =
      this.cfg.approver_role_ids.length === 0
        ? member.permissions.has(PermissionFlagsBits.ModerateMembers)
        : member.roles.cache.some((r) => this.cfg.approver_role_ids.includes(r.id));
    if (!allowed) {
      await i.reply({ content: "You are not allowed to approve moderation actions.", ephemeral: true });
      return true;
    }
    await i.deferUpdate();
    const t: Target = { guildId: i.guildId, ...parsed.t };
    let result: string;
    if (parsed.action === "reject") {
      result = `Rejected by ${member.user.tag}`;
      await this.log(`🚫 flag on <@${t.userId}> rejected by ${member.user.tag} — msg ${t.channelId}/${t.messageId}`);
    } else {
      const reason = i.message.embeds[0]?.title ?? "flag";
      result = `${await this.execute(parsed.action, t, reason, member)} (by ${member.user.tag})`;
    }
    const embed = EmbedBuilder.from(i.message.embeds[0] ?? new EmbedBuilder()).addFields({ name: "Outcome", value: result.slice(0, 1024) });
    // Disable buttons once a final decision (anything but delete) is taken; delete can be combined with a timeout etc.
    const final = parsed.action !== "delete";
    await i.editReply({ embeds: [embed], components: final ? [] : i.message.components });
    return true;
  }
}
