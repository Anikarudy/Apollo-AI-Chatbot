import { Router, Request, Response } from "express";
import { intentLimiter, generalLimiter } from "../middleware/rateLimit.middleware";
import { callLlm, hasAnyLlm, stripMarkdownJson } from "../lib/llmClient";
import { upsertSession } from "../services/chatSessionService";
import { logMessage } from "../services/chatMessageService";
import log from "../lib/logger";

export const intentRouter = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface IntentRequest {
  message: string;
  cities: string[];
  specialties: string[];
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  currentState?: string;
}

export interface ParsedIntent {
  intent:
    | "book_appointment"
    | "find_doctor"
    | "health_checkup"
    | "have_symptoms"
    | "emergency"
    | "change_doctor"
    | "unknown";
  specialty?: string;
  city?: string;
  branch?: string;
  doctorName?: string;
  symptomText?: string;
}

interface LogInteractionRequest {
  message: string;
  messageType: string;
  buttonLabel?: string;
  buttonValue?: string;
  machineState?: string;
  role?: "user" | "bot";
}

// ── POST /api/intent ──────────────────────────────────────────────────────────
intentRouter.post("/intent", intentLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ intent: "unknown" }); return; }

  const { message, cities, specialties, history, currentState: intentState } = req.body as IntentRequest;
  if (!message) { res.status(400).json({ error: "message required" }); return; }

  const historyBlock =
    (history ?? []).length > 0
      ? `\nRecent conversation (for context resolution):\n${(history ?? [])
          .map((h) => `${h.role === "user" ? "User" : "Bot"}: ${h.text}`)
          .join("\n")}\n`
      : "";

  const systemPrompt = `You are an intent parser for Apollo Hospitals chatbot.
Extract booking intent from the user message and return ONLY a valid JSON object (no markdown, no explanation).

Known cities: ${(cities ?? []).join(", ")}
Known specialties: ${(specialties ?? []).join(", ")}
Current bot state: ${intentState ?? "unknown"}${historyBlock}
JSON schema:
{
  "intent": "book_appointment" | "find_doctor" | "health_checkup" | "have_symptoms" | "emergency" | "change_doctor" | "unknown",
  "specialty": string | null,
  "city": string | null,
  "branch": string | null,
  "doctorName": string | null,
  "symptomText": string | null
}

Rules:
- CHANGE DOCTOR (highest priority when currentState is SHOW_DOCTORS): If the current bot state is "SHOW_DOCTORS" and the user is expressing a preference for a specific doctor by name — e.g. "no I want ramesh", "show me patel", "I prefer krishna", "ramsh", "no ramesh", or just a name like "priya sharma" — return { intent: "change_doctor", doctorName: "<name only>" }. Extract ONLY the name token; strip filler words like "no", "I want", "show me", "I prefer", "actually". Set doctorName to the name fragment as the user typed it (preserve misspellings). All other fields null.
- Use "have_symptoms" when user describes a medical symptom or health complaint (e.g. "ear block", "chest pain", "my knee hurts"). Set symptomText to the exact symptom phrase. Also map to the closest specialty when possible.
- Use "book_appointment" or "find_doctor" only if user explicitly mentions doctor/appointment/booking.
- NAME-ONLY DOCTOR QUERY: If the message looks like a person name (for example 2+ alphabetic words like "shamila pendyala") and currentState is NOT SHOW_DOCTORS, classify as "find_doctor" and set doctorName to that text.
- CONTEXT RESOLUTION: If the user's message is just an affirmation ("yes", "sure", "ok", "yeah", "proceed", "please", "correct") — look at the conversation history to understand what they are confirming, and extract specialty/city/doctorName from prior context.
- Set city if a known city is mentioned in the current message OR clearly referenced from history.
- Return null for any field not mentioned or inferable. Never guess.
- Return ONLY the raw JSON object, nothing else.`;

  try {
    const raw = (await callLlm(systemPrompt, `User message: "${message}"`))
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "");
    res.json(JSON.parse(raw) as ParsedIntent);
  } catch {
    res.json({ intent: "unknown" } as ParsedIntent);
  }
});

// ── POST /api/symptom-specialty ───────────────────────────────────────────────
intentRouter.post("/symptom-specialty", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ specialty: null }); return; }

  const { symptom, specialties } = req.body as { symptom: string; specialties: string[] };
  if (!symptom) { res.status(400).json({ error: "symptom required" }); return; }

  const systemPrompt = `You are a medical triage assistant for Apollo Hospitals.
Map the user's symptom to the single most relevant specialty from this list:
${(specialties ?? []).join(", ")}
Return ONLY: { "specialty": "<exact name>" } or { "specialty": null }. No markdown.`;

  try {
    const raw = (await callLlm(systemPrompt, `Patient says: "${symptom}"`))
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "");
    res.json(JSON.parse(raw) as { specialty: string | null });
  } catch {
    res.json({ specialty: null });
  }
});

// ── POST /api/detect-language ─────────────────────────────────────────────────
intentRouter.post("/detect-language", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ code: "en" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.json({ code: "en" }); return; }

  const systemPrompt = `Detect the language of the user's message. Return ONLY: { "code": "<ISO 639-1 code>" }
For romanized text (Latin script used to write a non-Latin language), detect the UNDERLYING language.
Examples: "naku doctor kavali" → Telugu romanized → {"code":"te"}; "mujhe doctor chahiye" → Hindi → {"code":"hi"}; "I need a doctor" → {"code":"en"}; "నాకు డాక్టర్ కావాలి" → {"code":"te"}
Supported codes: en, te, hi, ta, kn, ml, gu, bn, pa, ur, mr, or, si.
Return {"code":"en"} if uncertain. Return ONLY raw JSON, no markdown.`;

  try {
    const raw = stripMarkdownJson(
      await callLlm(systemPrompt, `Detect language of: "${String(text).slice(0, 200)}"`),
    );
    const parsed = JSON.parse(raw) as { code?: string };
    const code = String(parsed.code ?? "en")
      .toLowerCase()
      .trim()
      .slice(0, 5);
    res.json({ code: /^[a-z]{2,5}$/.test(code) ? code : "en" });
  } catch {
    res.json({ code: "en" });
  }
});

// ── POST /api/translate-ui ────────────────────────────────────────────────────
intentRouter.post("/translate-ui", async (req: Request, res: Response): Promise<void> => {
  const { strings, targetLanguage } = req.body as {
    strings?: string[];
    targetLanguage?: string;
  };

  if (!strings || !Array.isArray(strings) || strings.length === 0) {
    res.json({ translations: strings ?? [] });
    return;
  }
  if (!targetLanguage || targetLanguage === "en" || !hasAnyLlm) {
    res.json({ translations: strings });
    return;
  }

  const LANGUAGE_NAMES: Record<string, string> = {
    te: "Telugu", hi: "Hindi", ta: "Tamil", kn: "Kannada", ml: "Malayalam",
    gu: "Gujarati", bn: "Bengali", pa: "Punjabi", ur: "Urdu", mr: "Marathi",
    or: "Odia", si: "Sinhala",
  };
  const langName = LANGUAGE_NAMES[targetLanguage] ?? targetLanguage;

  const systemPrompt = `You are a JSON-only UI string translator for Apollo Hospitals India chatbot.
Target language: ${langName}.

INPUT: a JSON array of short UI strings (button labels and bot messages).
OUTPUT: a JSON array of the same strings translated to ${langName}. Output ONLY the JSON array — no markdown, no explanation, no extra keys.

STRICT RULES:
1. The output array MUST have exactly the same number of elements as the input array, in the same order.
2. These tokens MUST stay in English exactly as written: doctor names, hospital names, branch names, city names (e.g. Hyderabad, Chennai, Bangalore), phone numbers, and medical specialty names (Cardiology, Neurology, Orthopaedics, Gynaecology, Paediatrics, Oncology, Gastroenterology, ENT, Dermatology, Urology, etc.).
3. Preserve emoji characters exactly — do not remove, add, or replace them.
4. Button labels must be SHORT (≤ 6 words in ${langName}). Do not expand them into full sentences.
5. Do NOT add parenthetical English translations, footnotes, or explanations.
6. If a string is already in ${langName} or is a proper noun, return it unchanged.
7. Output raw JSON only. Do not wrap in markdown code fences.`;

  try {
    const raw = stripMarkdownJson(
      await callLlm(systemPrompt, `Translate to ${langName}: ${JSON.stringify(strings)}`),
    );
    const parsed = JSON.parse(raw) as unknown[];
    if (Array.isArray(parsed) && parsed.length === strings.length) {
      res.json({
        translations: parsed.map((t, i) =>
          typeof t === "string" && t.trim() ? t : strings[i],
        ),
      });
    } else {
      res.json({ translations: strings });
    }
  } catch {
    res.json({ translations: strings });
  }
});

// ── POST /api/summarize ───────────────────────────────────────────────────────
intentRouter.post("/summarize", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ summary: "" }); return; }

  const { messages } = req.body as {
    messages?: Array<{ role: "user" | "assistant"; text: string }>;
  };
  const turns = (messages ?? []).filter((m) => m.text?.trim());
  if (turns.length < 2) { res.json({ summary: "" }); return; }

  const systemPrompt = `You are a session memory assistant for the Apollo Hospitals chatbot.
Summarize the conversation below in 3–5 short bullet points.
Focus ONLY on factual actions: what the user searched for (doctor name, specialty, city, branch), which doctors appeared, any slots or bookings made.
Be concise — each bullet ≤ 15 words. No markdown headers. Start each line with "•".`;

  const dialogue = turns
    .map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.text}`)
    .join("\n");

  try {
    const raw = await callLlm(systemPrompt, dialogue);
    res.json({ summary: raw.trim() });
  } catch {
    res.json({ summary: "" });
  }
});

// ── POST /api/log-interaction ─────────────────────────────────────────────────
// Called by the frontend for button clicks (quick replies, doctor selections, slot picks)
// that do NOT go through /api/chat (they trigger static state transitions instead).
intentRouter.post(
  "/log-interaction",
  generalLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as LogInteractionRequest;
    if (!body.message || !body.messageType) {
      res.status(400).json({ error: "message and messageType required" });
      return;
    }
    // Ensure session row exists BEFORE inserting child message (FK constraint)
    await upsertSession(req.sessionId).catch((err) => {
      log.warn({ err }, "upsertSession failed in /api/log-interaction");
    });
    void logMessage({
      sessionId:    req.sessionId,
      role:         body.role ?? "user",
      message:      body.message,
      messageType:  body.messageType,
      buttonLabel:  body.buttonLabel,
      buttonValue:  body.buttonValue,
      machineState: body.machineState,
    }).catch((err) => {
      log.warn({ err }, "logMessage failed in /api/log-interaction");
    });
    res.json({ ok: true });
  },
);
