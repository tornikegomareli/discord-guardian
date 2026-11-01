import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { extractJson } from "../llm/provider.js";

export const Verdict = z.object({
  category: z.enum(["ok", "spam", "scam", "harassment", "piracy", "toxicity", "other"]),
  severity: z.enum(["none", "low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

const SYSTEM = `You are the moderation classifier of a Discord community. Questions, criticism, bug reports, feature requests and comparisons with other products are welcome and are "ok".

Classify the message. Respond with ONLY a JSON object:
{"category": "ok|spam|scam|harassment|piracy|toxicity|other", "severity": "none|low|medium|high", "confidence": 0.0-1.0, "reason": "one short sentence"}

Guidance:
- scam = phishing, fake nitro/giveaways, account selling, malware links -> usually high severity
- spam = unsolicited invites/ads, mass mentions
- scam also covers fake "staff/support" DMs, fake download links, and requests for passwords, API keys or payment details
- piracy = cracked builds, license key sharing/selling, reselling or trading beta invites
- Friendly banter, frustration about bugs and mild profanity are "ok". Do not over-flag.`;

export async function classify(
  llm: LlmClient,
  content: string,
  authorTag: string,
  channelName: string,
): Promise<Verdict | null> {
  const result = await llm.complete("classifier", SYSTEM, [
    {
      role: "user",
      content: `Channel: #${channelName}\nAuthor: ${authorTag}\nMessage:\n${content.slice(0, 1500)}`,
    },
  ], 256);
  if (!result) return null;
  try {
    return Verdict.parse(extractJson(result.text));
  } catch {
    return null; // unparseable verdict -> treat as no verdict, prefilter flag still posted
  }
}
