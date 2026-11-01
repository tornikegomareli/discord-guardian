import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, LlmProvider, LlmResult } from "./provider.js";

export class AnthropicProvider implements LlmProvider {
  private client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  async complete(
    model: string,
    system: string,
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<LlmResult> {
    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      inputTokens:
        response.usage.input_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
    };
  }
}
