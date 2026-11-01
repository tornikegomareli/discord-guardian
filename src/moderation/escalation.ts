import type { LlmClient } from "../llm/client.js";
import type { ChatMessage } from "../llm/provider.js";
import type { Verdict } from "./classifier.js";

const SYSTEM = `You are the senior moderation advisor of a Discord community. A message was flagged as potentially serious. You see the recent channel context.

Your job: recommend an action to the HUMAN moderators. You never act yourself.
Respond with a short report (max 120 words) in this format:

RECOMMENDATION: <none | delete message | timeout user | kick user | ban user>
RISK: <what happens if moderators ignore this>
ANALYSIS: <2-3 sentences: is this genuinely malicious or a false positive? Consider context, sarcasm and normal banter; angry bug reports are not abuse.>`;

export async function escalate(
  llm: LlmClient,
  verdict: Verdict,
  content: string,
  authorTag: string,
  channelContext: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Flagged message by ${authorTag}:\n"${content.slice(0, 1500)}"\n\nClassifier verdict: ${verdict.category} (severity ${verdict.severity}, confidence ${verdict.confidence})\nReason: ${verdict.reason}\n\nRecent channel context:\n${channelContext.slice(0, 3000)}`,
    },
  ];
  const result = await llm.complete("escalation", SYSTEM, messages, 512);
  return result?.text ?? null;
}
