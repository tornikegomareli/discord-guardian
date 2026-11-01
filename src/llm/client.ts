import type { Config } from "../config.js";
import type { BudgetTracker } from "../budget.js";
import type { ChatMessage, LlmProvider, LlmResult } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiCompatProvider } from "./openai-compat.js";

export type ModelRole = "classifier" | "chat" | "escalation" | "digest";

/**
 * Routes calls to the configured provider, picks the model for each role,
 * records spend, and refuses to call the API once the daily cap is reached.
 */
export class LlmClient {
  private provider: LlmProvider | null;

  constructor(
    private cfg: Config["llm"],
    private budget: BudgetTracker,
  ) {
    if (cfg.provider === "grokbot") {
      // No LLM calls at all: every complete() returns null and callers fall back to their no-LLM path.
      this.provider = null;
    } else if (cfg.provider === "anthropic") {
      this.provider = new AnthropicProvider();
    } else {
      const key = process.env.LLM_API_KEY ?? process.env.GLM_API_KEY;
      if (!key) throw new Error("LLM_API_KEY (or GLM_API_KEY) not set");
      this.provider = new OpenAiCompatProvider(cfg.base_url, key);
    }
  }

  get available(): boolean {
    return this.provider !== null && !this.budget.exhausted;
  }

  async complete(
    role: ModelRole,
    system: string,
    messages: ChatMessage[],
    maxTokens = 1024,
  ): Promise<LlmResult | null> {
    if (!this.provider || this.budget.exhausted) return null;
    const model = this.cfg.models[role];
    const result = await this.provider.complete(model, system, messages, maxTokens);
    this.budget.record(model, result.inputTokens, result.outputTokens);
    return result;
  }
}
