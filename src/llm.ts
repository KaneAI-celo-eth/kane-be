// Minimal OpenAI-compatible chat client (default: dgrid.ai). Used by the advisor.

import { config } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

/** Send a chat completion and return the assistant's text. Throws on HTTP / empty response. */
export async function chat(
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number },
): Promise<string> {
  if (!config.llm.apiKey) throw new Error("AI_AUTH_TOKEN not set");

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llm.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: opts?.maxTokens ?? 512,
      temperature: opts?.temperature ?? 0,
      messages,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");
  return content;
}
