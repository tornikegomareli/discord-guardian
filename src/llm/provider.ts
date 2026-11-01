export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  complete(
    model: string,
    system: string,
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<LlmResult>;
}

/** Strips markdown code fences some models wrap around JSON answers. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON in model output: ${text}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}
