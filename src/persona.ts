import type { Config } from "./config.js";
import type { MemoryStore } from "./memory.js";

/**
 * The agent's full identity block, shared by chat, welcomes, reactions and
 * proactive posts so the character stays consistent everywhere.
 */
export function buildIdentity(cfg: Config, memory: MemoryStore): string {
  return `${cfg.interactions.persona}

CHARACTER:
${cfg.personality.character}

Today is ${new Date().toISOString().slice(0, 10)}.

SERVER LORE (things you know about this community):
${memory.getLore()}

YOUR RECENT DIARY (what you did/noticed lately):
${memory.getRecentDiary()}`;
}
