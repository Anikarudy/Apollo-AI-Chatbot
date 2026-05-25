/**
 * backend/lib/llmClient.ts
 *
 * Shared LLM client — Gemini (primary) → Groq (fallback).
 * Exported callLlm is used by chat, intent, doctor, and agent routes.
 *
 * Note: dotenv.config() is called here so this module can be safely
 * imported before the caller has called it (idempotent).
 */
import dotenv from "dotenv";
dotenv.config();

import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import log from "./logger";

// Re-export for consumers that drive Gemini tool-calling directly
export { GoogleGenerativeAI };

const _groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

export const hasAnyLlm = !!(_groq || process.env.GEMINI_API_KEY);
export const NO_LLM_ERROR = "No LLM configured. Set GEMINI_API_KEY or GROQ_API_KEY in .env";

export function stripMarkdownJson(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Unified LLM call — tries Gemini first, then Groq as fallback.
 * Returns the response text string.
 */
export async function callLlm(
  systemPrompt: string,
  userContent: string,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<string> {
  type OpenAIMessage = { role: "system" | "user" | "assistant"; content: string };
  const historyMessages: OpenAIMessage[] = (history ?? []).map((h) => ({
    role: h.role,
    content: h.text,
  }));

  // ── 1. Gemini (primary) ───────────────────────────────────────────────────
  if (process.env.GEMINI_API_KEY) {
    try {
      const geminiModel = "gemini-2.0-flash";
      log.info({ provider: "gemini", model: geminiModel }, "[LLM] Trying provider");
      const model = genAI.getGenerativeModel({ model: geminiModel, systemInstruction: systemPrompt });
      const geminiHistory = (history ?? [])
        .filter((h) => String(h.text ?? "").trim().length > 0)
        .map((h) => ({
          role: h.role === "user" ? "user" : "model",
          parts: [{ text: h.text }],
        }));
      while (geminiHistory.length > 0 && geminiHistory[0].role !== "user") {
        geminiHistory.shift();
      }
      const chat = model.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(userContent);
      const text = result.response.text();
      if (text.trim()) {
        log.info({ provider: "gemini", model: geminiModel }, "[LLM] Response received");
        return text;
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      log.warn({ provider: "gemini", err: String(error.message ?? err) }, "[LLM] Provider failed, falling back");
    }
  }

  // ── 2. Groq (fallback) ────────────────────────────────────────────────────
  if (_groq) {
    const groqModel = "llama-3.3-70b-versatile";
    log.info({ provider: "groq", model: groqModel }, "[LLM] Trying provider");
    const completion = await _groq.chat.completions.create({
      model: groqModel,
      messages: [
        { role: "system", content: systemPrompt },
        ...historyMessages,
        { role: "user",   content: userContent },
      ],
      max_tokens: 256,
      temperature: 0.5,
    });
    const text = completion.choices[0]?.message?.content ?? "";
    log.info({ provider: "groq", model: groqModel }, "[LLM] Response received");
    return text;
  }

  throw new Error(NO_LLM_ERROR);
}
