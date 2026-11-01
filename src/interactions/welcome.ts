import type { GuildMember, TextChannel } from "discord.js";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import type { MemoryStore } from "../memory.js";
import { buildIdentity } from "../persona.js";

const RECENT_WELCOMES_KEPT = 5;

export class Welcomer {
  private recent: string[] = [];

  constructor(
    private cfg: Config,
    private llm: LlmClient,
    private memory: MemoryStore,
  ) {}

  async welcome(member: GuildMember, channel: TextChannel): Promise<void> {
    const system = `${buildIdentity(this.cfg, this.memory)}

Write a single short welcome message (max 2 sentences) for a new member joining the server. Mention them as ${member.toString()}. Vary style: avoid repeating these recent welcomes:
${this.recent.map((w) => `- ${w}`).join("\n") || "- (none yet)"}

No markdown headers, no quotes around the message.`;

    const result = await this.llm.complete("chat", system, [
      { role: "user", content: `New member: ${member.user.displayName}` },
    ], 200);

    // Budget exhausted or API error -> plain fallback so nobody joins in silence
    const text =
      result?.text?.slice(0, 500) ??
      `Welcome ${member.toString()}! Check the rules and enjoy the server.`;

    this.recent.push(text);
    if (this.recent.length > RECENT_WELCOMES_KEPT) this.recent.shift();
    await channel.send({ content: text });
  }
}
