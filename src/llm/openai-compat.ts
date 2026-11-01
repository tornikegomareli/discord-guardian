import type { ChatMessage, LlmProvider, LlmResult } from "./provider.js";

/**
 * Provider for any OpenAI-compatible chat-completions endpoint.
 * Tested with GLM (Zhipu AI / Z.ai). Also works with Ollama, vLLM, etc.
 */
export class OpenAiCompatProvider implements LlmProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async complete(
    model: string,
    system: string,
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<LlmResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices[0]?.message?.content ?? "",
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}
