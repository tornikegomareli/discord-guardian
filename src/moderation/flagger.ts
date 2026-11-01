import { EmbedBuilder, type Message, type TextChannel } from "discord.js";
import { buildButtons } from "./actions.js";
import type { Verdict } from "./classifier.js";

const SEVERITY_COLOR: Record<string, number> = {
  none: 0x95a5a6,
  low: 0xf1c40f,
  medium: 0xe67e22,
  high: 0xe74c3c,
};

/** Posts a moderation flag to the staff channel, with Approve/Reject buttons when withButtons is set. */
export async function postFlag(
  modChannel: TextChannel,
  message: Message,
  prefilterReason: string,
  verdict: Verdict | null,
  escalationReport: string | null,
  withButtons = false,
  autoOutcome: string | null = null,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(verdict ? `Flag: ${verdict.category} (${verdict.severity})` : "Flag: pre-filter match")
    .setColor(SEVERITY_COLOR[verdict?.severity ?? "low"] ?? 0x95a5a6)
    .setDescription(message.content.slice(0, 1000) || "*(no text content)*")
    .addFields(
      { name: "Author", value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Link", value: message.url, inline: true },
      { name: "Pre-filter", value: prefilterReason.slice(0, 200) },
    )
    .setTimestamp(message.createdAt);

  if (verdict) {
    embed.addFields({
      name: `Classifier (confidence ${verdict.confidence})`,
      value: verdict.reason.slice(0, 500),
    });
  }
  if (escalationReport) {
    embed.addFields({
      name: "Escalation review",
      value: escalationReport.slice(0, 1024),
    });
  }

  if (autoOutcome) embed.addFields({ name: "Auto action", value: autoOutcome.slice(0, 1024) });
  const components = withButtons
    ? buildButtons({ channelId: message.channelId, messageId: message.id, userId: message.author.id })
    : [];
  await modChannel.send({ embeds: [embed], components });
}
