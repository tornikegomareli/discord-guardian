import type { Message } from "discord.js";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";

/**
 * Occasional emoji reactions: a random sample of general-channel messages is
 * shown to the cheap model, which picks one fitting emoji or passes.
 * Probability + daily cap keep this basically free.
 */
export class Reactor {
  private reactionsToday = 0;
  private day = "";

  constructor(
    private cfg: Config["reactions"],
    private llm: LlmClient,
    private persona: () => string,
  ) {}

  private rollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.reactionsToday = 0;
    }
  }

  async maybeReact(message: Message): Promise<void> {
    if (!this.cfg.enabled) return;
    this.rollover();
    if (this.reactionsToday >= this.cfg.daily_max) return;
    if (Math.random() > this.cfg.probability) return;
    if (!message.content || message.content.length < 8) return;

    const result = await this.llm.complete(
      "classifier",
      `${this.persona()}

A member posted the message below. If it genuinely resonates with you (hype, funny, great find, impressive map theory), pick ONE fitting standard unicode emoji. Otherwise pass.
Respond with ONLY the emoji character, or the word PASS.`,
      [{ role: "user", content: `${message.author.displayName}: ${message.content.slice(0, 400)}` }],
      16,
    );
    if (!result) return;

    const answer = result.text.trim();
    if (!answer || /pass/i.test(answer) || answer.length > 8) return;
    try {
      await message.react(answer);
      this.reactionsToday++;
    } catch {
      // invalid emoji from the model -> ignore
    }
  }
}
