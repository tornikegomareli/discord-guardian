import type { Config } from "./config.js";

export class BudgetTracker {
  private spentUsd = 0;
  private day = new Date().toISOString().slice(0, 10);
  private warned = false;
  private exhaustedNotified = false;
  onWarn?: (spent: number, cap: number) => void;
  onExhausted?: (spent: number, cap: number) => void;

  constructor(
    private cfg: Config["budget"],
    private pricing: Config["llm"]["pricing"],
  ) {}

  private rollover() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spentUsd = 0;
      this.warned = false;
      this.exhaustedNotified = false;
    }
  }

  get exhausted(): boolean {
    this.rollover();
    return this.spentUsd >= this.cfg.daily_usd_cap;
  }

  get spent(): number {
    this.rollover();
    return this.spentUsd;
  }

  record(model: string, inputTokens: number, outputTokens: number) {
    this.rollover();
    // Unknown models are billed at a conservative default so a config typo
    // can't silently bypass the cap.
    const price = this.pricing[model] ?? { input: 5.0, output: 25.0 };
    this.spentUsd +=
      (inputTokens / 1_000_000) * price.input +
      (outputTokens / 1_000_000) * price.output;

    const cap = this.cfg.daily_usd_cap;
    if (!this.warned && this.spentUsd >= cap * this.cfg.warn_fraction && this.spentUsd < cap) {
      this.warned = true;
      this.onWarn?.(this.spentUsd, cap);
    }
    if (this.spentUsd >= cap && !this.exhaustedNotified) {
      this.exhaustedNotified = true;
      this.onExhausted?.(this.spentUsd, cap);
    }
  }
}
