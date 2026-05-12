import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI, FunctionCallingMode } from "@google/generative-ai";
import Groq from "groq-sdk";
import axios from "axios";
import { buildDoctorSearchUrl, contacts, getDoctorsByName, getDoctorsForLocation, getLocationFallbacksForCity, doctors, hospitalsByCity } from "../src/knowledgeBase";
import { getLocationFromBranch } from "../data/locationMap";
import {
  mapBookAppointmentForAgent,
  mapCalendarDatesForAgent,
  mapDoctorsForAgent,
  mapSlotsForAgent,
} from "./agentHandlers";
import { searchDoctors, SEARCH_DOCTORS_TOOL, fuzzySearchAllDoctors } from "./searchDoctors";
import {
  findPatient,
  registerPatient,
  saveAppointment,
  getLatestPatientAppointment,
} from "./db";

dotenv.config();

const app = express();
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
app.use(cors({ origin: frontendOrigin }));
app.use(express.json());

// ── Request/response logging middleware ──────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    if (status < 400) {
      console.log(`[API] ${req.method} ${req.path} → ${status} (${ms}ms)`);
    } else {
      console.warn(`[API] ${req.method} ${req.path} → ${status} (${ms}ms)`);
    }
  });
  next();
});
const PORT = Number(process.env.PORT ?? 3001);
const LOCAL_API_BASE = `http://127.0.0.1:${PORT}`;
const INTERNAL_TOOL_TIMEOUT_MS = 30000;
const INTERNAL_EDOC_TOOL_TIMEOUT_MS = 90000;

// ── LLM clients (Gemini -> Groq priority; DeepSeek commented out) ──
// const deepseekKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
const hasAnyLlm = !!(groq || process.env.GEMINI_API_KEY);
const NO_LLM_ERROR = "No LLM configured. Set GEMINI_API_KEY or GROQ_API_KEY in .env";

/**
 * Unified LLM call — tries Gemini first, then Groq as fallback. DeepSeek commented out.
 * Returns the response text string.
 * @param history Prior conversation turns (user/assistant alternating) for multi-turn memory.
 */
async function callLlm(
  systemPrompt: string,
  userContent: string,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<string> {
  type OpenAIMessage = { role: "system" | "user" | "assistant"; content: string };
  const historyMessages: OpenAIMessage[] = (history ?? []).map((h) => ({
    role: h.role,
    content: h.text,
  }));

  // ── DeepSeek (commented out) ─────────────────────────────────────────────
  // if (deepseekKey) { ... }

  // ── 1. Gemini (primary) ───────────────────────────────────────────────────
  if (process.env.GEMINI_API_KEY) {
    try {
      const geminiModel = "gemini-2.0-flash";
      console.log(`[LLM] Trying Gemini (${geminiModel})`);
      const model = genAI.getGenerativeModel({ model: geminiModel, systemInstruction: systemPrompt });
      const geminiHistory = (history ?? [])
        .filter((h) => String(h.text ?? "").trim().length > 0)
        .map((h) => ({
          role: h.role === "user" ? "user" : "model",
          parts: [{ text: h.text }],
        }));
      // Gemini chat history must begin with a user turn.
      while (geminiHistory.length > 0 && geminiHistory[0].role !== "user") {
        geminiHistory.shift();
      }
      const chat = model.startChat({
        history: geminiHistory,
      });
      const result = await chat.sendMessage(userContent);
      const text = result.response.text();
      if (text.trim()) {
        console.log(`[LLM] Response from Gemini (${geminiModel})`);
        return text;
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.warn("[LLM] Gemini failed, falling back to Groq:", String(error.message ?? err));
    }
  }

  // ── 2. Groq (fallback) ────────────────────────────────────────────────────
  if (groq) {
    const groqModel = "llama-3.3-70b-versatile";
    console.log(`[LLM] Trying Groq (${groqModel})`);
    const completion = await groq.chat.completions.create({
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
    console.log(`[LLM] Response from Groq (${groqModel})`);
    return text;
  }

  throw new Error(NO_LLM_ERROR);
}

// ── Apollo EDOC API config (server-side only – AuthKey never sent to browser) ──
const EDOC_BASE = (process.env.APOLLO_EDOC_BASE_URL ?? "").replace(/\/$/, "");
const EDOC_AUTH = process.env.APOLLO_EDOC_AUTH_KEY ?? "";
function edocHeaders() {
  return { AuthKey: EDOC_AUTH, "Content-Type": "application/json" };
}
function requireEdoc(res: Response): boolean {
  if (!EDOC_BASE || !EDOC_AUTH) {
    res.status(503).json({ error: "EDOC API not configured. Set APOLLO_EDOC_BASE_URL and APOLLO_EDOC_AUTH_KEY in .env" });
    return false;
  }
  return true;
}

function logEdoc(step: string, payload: unknown): void {
  try {
    console.info(`[EDOC] ${step} ${JSON.stringify(payload)}`);
  } catch {
    console.info(`[EDOC] ${step}`, payload);
  }
}

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

/** Convert "1/7/2025" (D/M/YYYY) → "01-JUL-2025" */
function toEdocDate(d: string): string {
  const [day, mon, yr] = d.split("/");
  return `${day.padStart(2, "0")}-${MONTHS[parseInt(mon) - 1]}-${yr}`;
}

/** Add `minutes` to "HH:MM" string → "HH:MM" */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function isNumericLocationId(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? "").trim());
}

function normaliseNameForIdLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bdr\.?\s*/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getResourceCandidatesForDoctor(doctorName: string, city: string): string[] {
  const nameKey = normaliseNameForIdLookup(doctorName);
  const cityKey = city.toLowerCase();
  const candidates = doctors
    .filter((d) => d.location.toLowerCase() === cityKey)
    .filter((d) => normaliseNameForIdLookup(d.name) === nameKey)
    .map((d) => String(d.resourceId ?? "").trim())
    .filter((v) => v.length > 0);
  return Array.from(new Set(candidates)).slice(0, 8);
}

type LocalDoctor = (typeof doctors)[number];

interface DoctorCardPayload {
  resourceIds: string[];
  name: string;
  specialty: string;
  hospital: string;
  profileUrl: undefined;
  resourceId: string;
  locationId: string;
  regionId: string;
  serviceId: string;
}

function dedupeDoctorsForCards(items: LocalDoctor[]): LocalDoctor[] {
  const seen = new Set<string>();
  const result: LocalDoctor[] = [];
  for (const doctor of items) {
    const nameKey = normaliseNameForIdLookup(doctor.name);
    const locationId = String(doctor.locationId ?? "").trim();
    const regionId = String(doctor.regionId ?? "5").trim();
    const city = String(doctor.location ?? "").trim().toLowerCase();
    const branch = String(doctor.branch ?? "").trim().toLowerCase();
    const locationKey = locationId || `${city}|${branch}`;
    const key = `${nameKey}|${locationKey}|${regionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(doctor);
  }
  return result;
}

function toDoctorCardPayload(doctor: LocalDoctor): DoctorCardPayload {
  return {
    resourceIds: getResourceCandidatesForDoctor(doctor.name, doctor.location),
    name: doctor.name,
    specialty: doctor.speciality,
    hospital: doctor.branch ? `Apollo ${doctor.branch}, ${doctor.location}` : `Apollo Hospitals, ${doctor.location}`,
    profileUrl: undefined,
    resourceId: doctor.resourceId,
    locationId: doctor.locationId,
    regionId: doctor.regionId || "5",
    serviceId: doctor.serviceId,
  };
}

function buildDoctorQueryText(params: { name?: string; specialty?: string; city?: string; branch?: string }): string {
  const parts = [
    String(params.name ?? "").trim(),
    String(params.specialty ?? "").trim(),
    String(params.branch ?? "").trim(),
    String(params.city ?? "").trim(),
  ].filter((v) => v.length > 0);
  return parts.join(" | ");
}

async function rerankDoctorCandidates(
  queryText: string,
  candidates: LocalDoctor[],
  limit = 12,
): Promise<LocalDoctor[]> {
  if (!hasAnyLlm || candidates.length <= 1) return candidates.slice(0, limit);

  const shortlist = candidates.slice(0, 10);
  const compactCandidates = shortlist.map((doctor, index) => ({
    rank: index + 1,
    name: doctor.name,
    specialty: doctor.speciality,
    city: doctor.location,
    branch: doctor.branch,
  }));

  const systemPrompt = `You are a doctor-search ranking assistant.
You receive a user search query and up to 10 retrieved doctor candidates.
Return ONLY a JSON object with this exact schema:
{
  "selectedRanks": number[]
}

Rules:
- Select the most relevant candidates for the query intent.
- Prioritise semantic intent, not just literal token overlap.
- Respect location/specialty cues when present.
- Keep order best-first.
- Return only rank numbers from the provided list.
- Return at least 1 rank and at most ${Math.min(limit, 10)} ranks.
- Return raw JSON only, no markdown.`;

  const userPrompt = JSON.stringify({
    query: queryText,
    candidates: compactCandidates,
  });

  try {
    const raw = stripMarkdownJson(await callLlm(systemPrompt, userPrompt));
    const parsed = JSON.parse(raw) as { selectedRanks?: unknown };
    const ranks = Array.isArray(parsed.selectedRanks) ? parsed.selectedRanks : [];
    const selected = Array.from(new Set(
      ranks
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= shortlist.length)
    ))
      .slice(0, Math.min(limit, shortlist.length))
      .map((rank) => shortlist[rank - 1]);

    if (selected.length > 0) return selected;
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.warn("[LLM] Doctor rerank failed, falling back to retrieval order:", String(error.message ?? err));
  }

  return shortlist.slice(0, limit);
}

/**
 * Resolve the correct RegionID for an EDOC call.
 * Uses the branch → regionId mapping when available, falls back to provided or "1" for Hyderabad.
 */
function resolveRegionId(branch: string | undefined, provided?: string): number {
  if (provided && provided !== "5") return Number(provided);
  if (branch) {
    const mapped = getLocationFromBranch(branch);
    if (mapped) return Number(mapped.regionId);
  }
  return Number(provided ?? "5");
}

/**
 * Detects EDOC's "no real schedule configured" fallback response.
 * EDOC returns a full 00:00-23:45 grid (≥90 slots, starts at midnight)
 * when a doctor has no actual schedule at that location.
 */
function isFakeSchedule(slots: string[]): boolean {
  if (!slots || slots.length === 0) return false; // empty is handled separately
  if (slots.length >= 90) return true;            // full-day grid = fake
  if (slots[0] === "00:00") return true;          // starts at midnight = fake
  return false;
}

function getLocationCandidates(city?: string, preferred?: string, resourceId?: string, branch?: string): string[] {
  const result: string[] = [];
  const add = (v?: string) => {
    const val = String(v ?? "").trim();
    if (!val) return;
    if (!isNumericLocationId(val)) return;
    if (!result.includes(val)) result.push(val);
  };

  add(preferred);

  // Branch is the most reliable source: one branch = one locationId
  if (branch) {
    const mapped = getLocationFromBranch(branch);
    if (mapped) add(mapped.locationId);
  }

  const resourceInput = String(resourceId ?? "").trim();
  if (resourceInput) {
    // Fallback: check the doctors array (populated from clean.json + branch map)
    doctors
      .filter((doctor) => String(doctor.resourceId ?? "").trim() === resourceInput)
      .forEach((doctor) => add(doctor.locationId));
  }

  const cityInput = String(city ?? "").trim();
  if (!cityInput) return result;

  const cityKey = Object.keys(hospitalsByCity).find((k) => k.toLowerCase() === cityInput.toLowerCase());
  if (cityKey) {
    const hospitals = hospitalsByCity[cityKey] ?? [];
    hospitals.forEach((h) => add(h.locationId));
  }

  // Final fallback for corrupted source IDs: use city-level legacy location mapping.
  getLocationFallbacksForCity(cityInput).forEach((locationId) => add(locationId));
  return result;
}


interface ChatRequest {
  currentState?: string;
  context?: Record<string, string | undefined>;
  userMessage?: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  summary?: string;
  /** ISO 639-1 language code detected from the user's messages (e.g. "te", "hi"). */
  userLanguage?: string;
}

type AgentAction = "fetch_doctors" | "get_live_slots" | "book_appointment" | "unknown";

interface AgentToolRequest {
  message: string;
  context?: Record<string, unknown>;
}

interface AgentToolDecision {
  action: AgentAction;
  params?: Record<string, unknown>;
}

function stripMarkdownJson(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();
}

function asNonEmptyString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function inferActionFromMessage(message: string): AgentAction {
  const lower = message.toLowerCase();
  if (/book|appointment|reserve|schedule/i.test(lower)) return "book_appointment";
  if (/slot|live date|availability|available/i.test(lower)) return "get_live_slots";
  if (/doctor|specialist|consult/i.test(lower)) return "fetch_doctors";
  return "unknown";
}

async function getAgentDecision(message: string, context?: Record<string, unknown>): Promise<AgentToolDecision> {
  if (!hasAnyLlm) {
    return { action: inferActionFromMessage(message), params: context ?? {} };
  }

  const systemPrompt = `You are an Apollo API tool router.
Return ONLY a valid JSON object.

Schema:
{
  "action": "fetch_doctors" | "get_live_slots" | "book_appointment" | "unknown",
  "params": {
    "city": string | null,
    "specialty": string | null,
    "doctorName": string | null,
    "resourceId": string | null,
    "locationId": string | null,
    "regionId": string | null,
    "date": string | null,
    "bookingPayload": object | null
  }
}

Rules:
- Use "get_live_slots" only if user asks availability/live slots/dates.
- Use "book_appointment" only if user asks to book/reserve/schedule.
- Use "fetch_doctors" for doctor search intent.
- If value is unknown, set it to null.
- Return ONLY raw JSON, no markdown.`;

  const userPrompt = JSON.stringify({ message, context: context ?? {} });

  try {
    const raw = stripMarkdownJson(await callLlm(systemPrompt, userPrompt));
    const parsed = JSON.parse(raw) as AgentToolDecision;
    if (!parsed || !parsed.action) {
      return { action: inferActionFromMessage(message), params: context ?? {} };
    }

    const inferred = inferActionFromMessage(message);
    const allowedActions: AgentAction[] = ["fetch_doctors", "get_live_slots", "book_appointment", "unknown"];
    const parsedAction = allowedActions.includes(parsed.action) ? parsed.action : "unknown";
    const action = parsedAction === "unknown" && inferred !== "unknown" ? inferred : parsedAction;

    return {
      action,
      params: parsed.params ?? context ?? {},
    };
  } catch {
    return { action: inferActionFromMessage(message), params: context ?? {} };
  }
}

async function localGet(path: string, params: Record<string, unknown>, timeoutMs = INTERNAL_TOOL_TIMEOUT_MS): Promise<unknown> {
  const response = await axios.get(`${LOCAL_API_BASE}${path}`, { params, timeout: timeoutMs });
  return response.data;
}

async function localPost(path: string, body: Record<string, unknown>, timeoutMs = INTERNAL_TOOL_TIMEOUT_MS): Promise<unknown> {
  const response = await axios.post(`${LOCAL_API_BASE}${path}`, body, { timeout: timeoutMs });
  return response.data;
}

// ── 1. LLM chat ───────────────────────────────────────────────────────────────
app.post("/api/chat", async (req: Request, res: Response): Promise<void> => {
  const payload = (req.body ?? {}) as ChatRequest;
  const currentState = String(payload.currentState ?? "MAIN_MENU");
  const context = payload.context ?? {};
  const userMessage = payload.userMessage;
  const summary = (payload.summary ?? "").trim();
  const userLanguage = String(payload.userLanguage ?? "").trim();

  if (!hasAnyLlm) {
    res.status(503).json({ error: NO_LLM_ERROR });
    return;
  }

  const kbContext = [
    "=== Apollo Assist Context ===",
    `Current bot state: ${currentState}`,
    `Selected city: ${String(context.city ?? "N/A")}`,
    `Selected branch: ${String(context.branch ?? "N/A")}`,
    `Selected specialty: ${String(context.specialty ?? "N/A")}`,
    `Selected doctor: ${String(context.doctorName ?? "N/A")}`,
    `Emergency: ${contacts.emergency} | Health Helpline: ${contacts.healthHelpLine}`,
    `International services: ${contacts.internationalEmail} | ${contacts.apolloLifelineInternational}`,
  ].join("\n");

  // ── Hard guardrail: deflect meta/internal questions ──────────────────────
  const INTERNAL_RE = [
    /\b(what|which|tell me)[^.]*?(model|llm|ai engine|gpt|gemini|groq|claude|language model)/i,
    /\b(are you|were you)[^.]*?(built|made|powered|running on|using|trained)/i,
    /\b(your|the)[^.]*?(codebase|source code|repository|repo|github|backend|api key|env)/i,
    /\b(ignore|disregard|forget)[^.]*?(instructions|rules|guidelines)/i,
    /\bsystem prompt\b/i,
    /\bprompt injection\b/i,
    /\bwhat (model|ai|technology) (do )?you use/i,
    /\bhow (are|were) you (built|made|created|trained)/i,
    /\bwhere is your (code|codebase|source)/i,
    /\b(act as|pretend (to be|you are)|you are now)[^.]*?(gpt|claude|llama|gemini|ai|model)/i,
  ];
  if (userMessage && INTERNAL_RE.some((r) => r.test(userMessage))) {
    res.json({ text: "I'm Apollo Assist, your dedicated health assistant for Apollo Hospitals. I can help with doctor searches, appointments, and healthcare information. How can I assist you today?" });
    return;
  }

  const CHAT_LANG_NAMES: Record<string, string> = {
    te: "Telugu", hi: "Hindi", ta: "Tamil", kn: "Kannada", ml: "Malayalam",
    gu: "Gujarati", bn: "Bengali", pa: "Punjabi", ur: "Urdu", mr: "Marathi",
    or: "Odia", si: "Sinhala",
  };
  const detectedLangName = CHAT_LANG_NAMES[userLanguage ?? ""] ?? "";

  // Language block prepended at the very top of the system prompt so the LLM
  // sees it before any other instruction.  Kept separate from the Rules list so
  // it cannot be softened by later bullets.
  const langHeader = detectedLangName
    ? `=== RESPONSE LANGUAGE: ${detectedLangName.toUpperCase()} ===
You MUST write your entire response in ${detectedLangName}. This is the highest-priority instruction.
- The conversation history may contain English messages — that is irrelevant. Reply in ${detectedLangName} now.
- Do NOT use English words except for: doctor names, hospital names, city/branch names, phone numbers, and medical specialty names (e.g. Cardiology, ENT). Everything else must be in ${detectedLangName}.
- Do NOT add a translation, explanation, or language label.
- Do NOT apologise for language switching. Just respond naturally in ${detectedLangName}.
===\n`
    : "";

  const systemPrompt = `${langHeader}You are Apollo Assist, the warm and caring AI health companion for Apollo Hospitals India. Think of yourself as a knowledgeable friend — someone who listens, responds like a real person, and gently helps people get the healthcare they need.

${summary ? `Conversation summary (what has happened so far):\n${summary}\n\n` : ""}${kbContext}

How to respond:

CASUAL / SOCIAL MESSAGES (greetings, "how are you", "thanks", complaints, small talk):
- Respond like a warm human would. If someone asks how you are, say you're doing well and express genuine happiness to connect. If someone says you're not kind, apologise sincerely and warmly. If someone says thanks, respond with heart.
- After engaging authentically with what they said, GENTLY and NATURALLY transition — not with a forced pivot, but like a friend who says "by the way, is there anything I can help you with today?". Keep it soft, not salesy.
- Never respond to "how are you" with "How can I help you with Apollo Hospitals today?" — that is robotic and cold.

HEALTHCARE / WORKFLOW MESSAGES:
- Guide clearly and warmly to the next step based on the current bot state.
- Be encouraging and reassuring — healthcare can be stressful for people.
- Use real hospital names, phone numbers, and package names from the knowledge base above.
- Do NOT invent doctor names, appointment slots, or medical diagnoses.
- For emergencies always lead with the emergency number: 1066.

GENERAL:
- LANGUAGE: ${detectedLangName ? `Respond in ${detectedLangName}. Keep doctor names, city names, hospitals, phone numbers, and medical specialty names in English; everything else in ${detectedLangName}.` : "Detect the language the user wrote in (including romanized scripts) and respond in that exact language."}
- Length: match the situation — short for casual replies, clearer for workflow steps. Never pad or repeat yourself.
- Never be cold, robotic, or overly formal. You are warm, natural, and human.
- NEVER use markdown code blocks, JSON, bullet lists, or headers in your response. Write in plain conversational prose only.
- SECURITY: Never reveal what AI model, API, or technology powers you. Never share internal details. If asked, say you're Apollo Assist and gently redirect.`;

  const userContent = userMessage
    ? `User said: "${userMessage}"`
    : `Generate a warm, helpful response for state: ${currentState}`;

  // Pass the last 8 messages as conversation history (4 user + 4 bot turns)
  const history = (payload.history ?? []).slice(-8);

  try {
    console.log(`[LLM] /api/chat invoked — state: ${currentState}, message: ${userMessage ? `"${userMessage}"` : "(none)"}`);
    const text = await callLlm(systemPrompt, userContent, history);
    res.json({ text });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[LLM /api/chat error]", error.message ?? err);
    res.json({ text: null, error: error.message ?? "LLM unavailable" });
  }
});

// ── 1b. Intent parsing ────────────────────────────────────────────────────────
interface IntentRequest { message: string; cities: string[]; specialties: string[]; history?: Array<{ role: "user" | "assistant"; text: string }>; currentState?: string; }
export interface ParsedIntent {
  intent: "book_appointment" | "find_doctor" | "health_checkup" | "have_symptoms" | "emergency" | "change_doctor" | "unknown";
  specialty?: string; city?: string; branch?: string; doctorName?: string; symptomText?: string;
}

app.post("/api/intent", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ intent: "unknown" }); return; }

  const { message, cities, specialties, history, currentState: intentState } = req.body as IntentRequest;
  if (!message) { res.status(400).json({ error: "message required" }); return; }

  const historyBlock = (history ?? []).length > 0
    ? `\nRecent conversation (for context resolution):\n${(history ?? []).map((h) => `${h.role === "user" ? "User" : "Bot"}: ${h.text}`).join("\n")}\n`
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
- CONTEXT RESOLUTION: If the user's message is just an affirmation ("yes", "sure", "ok", "yeah", "proceed", "please", "correct") — look at the conversation history to understand what they are confirming, and extract specialty/city/doctorName from prior context. E.g. if the bot said "I recommend ENT specialist", and user says "yes", return { intent: "find_doctor", specialty: "ENT" }. E.g. if bot said "Would you like to book in Hyderabad?", and user says "sure", return { intent: "book_appointment", city: "Hyderabad" }.
- Set city if a known city is mentioned in the current message OR clearly referenced from history.
- Return null for any field not mentioned or inferable. Never guess.
- Return ONLY the raw JSON object, nothing else.`;

  try {
    const raw = (await callLlm(systemPrompt, `User message: "${message}"`))
      .trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    res.json(JSON.parse(raw) as ParsedIntent);
  } catch {
    res.json({ intent: "unknown" } as ParsedIntent);
  }
});

// ── 1c. Symptom → Specialty ───────────────────────────────────────────────────
app.post("/api/symptom-specialty", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ specialty: null }); return; }

  const { symptom, specialties } = req.body as { symptom: string; specialties: string[] };
  if (!symptom) { res.status(400).json({ error: "symptom required" }); return; }

  const systemPrompt = `You are a medical triage assistant for Apollo Hospitals.
Map the user's symptom to the single most relevant specialty from this list:
${(specialties ?? []).join(", ")}
Return ONLY: { "specialty": "<exact name>" } or { "specialty": null }. No markdown.`;

  try {
    const raw = (await callLlm(systemPrompt, `Patient says: "${symptom}"`))
      .trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    res.json(JSON.parse(raw) as { specialty: string | null });
  } catch {
    res.json({ specialty: null });
  }
});

// ── 1d. Conversation summarizer ───────────────────────────────────────────────
app.post("/api/summarize", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ summary: "" }); return; }

  const { messages } = req.body as { messages?: Array<{ role: "user" | "assistant"; text: string }> };
  const turns = (messages ?? []).filter((m) => m.text?.trim());
  if (turns.length < 2) { res.json({ summary: "" }); return; }

  const systemPrompt = `You are a session memory assistant for the Apollo Hospitals chatbot.
Summarize the conversation below in 3–5 short bullet points.
Focus ONLY on factual actions: what the user searched for (doctor name, specialty, city, branch), which doctors appeared, any slots or bookings made.
Be concise — each bullet ≤ 15 words. No markdown headers. Start each line with "•".`;

  const dialogue = turns.map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.text}`).join("\n");

  try {
    const raw = await callLlm(systemPrompt, dialogue);
    res.json({ summary: raw.trim() });
  } catch {
    res.json({ summary: "" });
  }
});

// ── Language detection ────────────────────────────────────────────────────────
// Detects the language of a user message (supports romanized scripts).
app.post("/api/detect-language", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json({ code: "en" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.json({ code: "en" }); return; }

  const systemPrompt = `Detect the language of the user's message. Return ONLY: { "code": "<ISO 639-1 code>" }
For romanized text (Latin script used to write a non-Latin language), detect the UNDERLYING language.
Examples: "naku doctor kavali" → Telugu romanized → {"code":"te"}; "mujhe doctor chahiye" → Hindi → {"code":"hi"}; "I need a doctor" → {"code":"en"}; "నాకు డాక్టర్ కావాలి" → {"code":"te"}
Supported codes: en, te, hi, ta, kn, ml, gu, bn, pa, ur, mr, or, si.
Return {"code":"en"} if uncertain. Return ONLY raw JSON, no markdown.`;

  try {
    const raw = stripMarkdownJson(await callLlm(systemPrompt, `Detect language of: "${String(text).slice(0, 200)}"`));
    const parsed = JSON.parse(raw) as { code?: string };
    const code = String(parsed.code ?? "en").toLowerCase().trim().slice(0, 5);
    res.json({ code: /^[a-z]{2,5}$/.test(code) ? code : "en" });
  } catch {
    res.json({ code: "en" });
  }
});

// ── UI translation (batch strings) ───────────────────────────────────────────
// Translates an array of UI strings (button labels, bot messages) to a target language.
// Keeps doctor names, city names, hospital names, and medical specialties in English.
app.post("/api/translate-ui", async (req: Request, res: Response): Promise<void> => {
  const { strings, targetLanguage } = req.body as { strings?: string[]; targetLanguage?: string };
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
      await callLlm(systemPrompt, `Translate to ${langName}: ${JSON.stringify(strings)}`)
    );
    const parsed = JSON.parse(raw) as unknown[];
    if (Array.isArray(parsed) && parsed.length === strings.length) {
      res.json({
        translations: parsed.map((t, i) =>
          typeof t === "string" && t.trim() ? t : strings[i]
        ),
      });
    } else {
      res.json({ translations: strings });
    }
  } catch {
    res.json({ translations: strings });
  }
});

app.get("/api/doctors", async (req: Request, res: Response): Promise<void> => {
  const specialty = String(req.query.specialty ?? "").trim();
  const city      = String(req.query.city      ?? "").trim();
  const branch    = String(req.query.branch    ?? "").trim();
  const name      = String(req.query.name      ?? "").trim();

  const normaliseDoctorName = (value: string): string =>
    value
      .toLowerCase()
      .replace(/\bdr\.?\s*/g, "")
      .replace(/[^a-z\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // ─ Normalise specialty: handle US/UK spelling variants and case ───────────────
  const US_TO_UK: Record<string, string> = {
    "pediatrics": "paediatrics",
    "gynecology": "gynaecology",
    "gynecologist": "gynaecology",
    "orthopedics": "orthopaedics",
    "anesthesiology": "anaesthesiology",
    "fetal medicine": "foetal medicine",
    "hematology": "haematology",
    "hemato oncology": "haemato oncology",
  };
  const normaliseSpecialty = (s: string) => {
    const lower = s.toLowerCase().trim();
    return US_TO_UK[lower] ?? lower;
  };
  const specNorm = normaliseSpecialty(specialty);

  // ── 1a. Name-based search: fuzzy via Fuse.js — handles misspellings and partial names ──
  if (name) {
    // First try strict name lookup (same source used by state responses) so exact names
    // like "Sharmila Pendyala" never get lost in fuzzy scoring.
    const strictMatched = getDoctorsByName(name, 200);
    let matched = strictMatched.length > 0 ? strictMatched : fuzzySearchAllDoctors(name, 200);

    if (city)    matched = matched.filter(d => d.location.toLowerCase() === city.toUpperCase().toLowerCase());
    if (branch)  matched = matched.filter(d => d.branch.toLowerCase() === branch.toUpperCase().toLowerCase());
    // Also filter by specialty if provided (e.g. user searched by name AND changed to specialty)
    if (specialty) matched = matched.filter(d => {
      const ds = normaliseSpecialty(d.speciality);
      return ds === specNorm || ds === specialty.toLowerCase();
    });

    const normalizedRequestedName = normaliseDoctorName(name);
    const hasExactNameMatch = matched.some((doctor) =>
      normaliseDoctorName(doctor.name) === normalizedRequestedName
    );

    const uniqueMatched = dedupeDoctorsForCards(matched);
    const reranked = await rerankDoctorCandidates(
      buildDoctorQueryText({ name, specialty, city, branch }),
      uniqueMatched,
      12,
    );
    const url = buildDoctorSearchUrl(specialty, city, branch);
    res.json({
      url,
      source: hasAnyLlm ? "local+llm-rerank" : "local",
      nameFallback: !hasExactNameMatch && uniqueMatched.length > 0
        ? { requestedName: name }
        : null,
      doctors: reranked.map(toDoctorCardPayload),
    });
    return;
  }

  // ── 1b. City/branch + optional specialty ─────────────────────────────────
  if (city || branch) {
    const localDocs = getDoctorsForLocation(city, branch || undefined, specialty || undefined);
    // If specialty didn't match, try with the normalised UK spelling
    const finalDocs = localDocs.length > 0
      ? localDocs
      : specNorm !== specialty.toLowerCase()
        ? getDoctorsForLocation(city, branch || undefined, specNorm)
        : [];
    if (finalDocs.length > 0) {
      const uniqueDocs = dedupeDoctorsForCards(finalDocs);
      const reranked = await rerankDoctorCandidates(
        buildDoctorQueryText({ specialty, city, branch }),
        uniqueDocs,
        12,
      );
      const url = buildDoctorSearchUrl(specialty, city, branch);
      res.json({
        url,
        source: hasAnyLlm ? "local+llm-rerank" : "local",
        doctors: reranked.map(toDoctorCardPayload),
      });
      return;
    }
  }

  // ── 1c. Specialty-only (no city/branch): search local KB ─────────────────
  if (specialty && !city && !branch) {
    const specDocs = dedupeDoctorsForCards(doctors
      .filter(d => {
        const ds = normaliseSpecialty(d.speciality);
        return ds === specNorm || ds === specialty.toLowerCase();
      })
      .slice(0, 50));
    if (specDocs.length > 0) {
      const reranked = await rerankDoctorCandidates(
        buildDoctorQueryText({ specialty }),
        specDocs,
        12,
      );
      res.json({
        url: buildDoctorSearchUrl(specialty),
        source: hasAnyLlm ? "local+llm-rerank" : "local",
        doctors: reranked.map(toDoctorCardPayload),
      });
      return;
    }
  }

  // ── 2. Nothing found locally — do NOT scrape (scraper returns wrong doctors) ─
  res.json({
    url: buildDoctorSearchUrl(specialty, city, branch),
    source: "local",
    notFound: true,
    doctors: [],
  });
});

// 1d. LLM agent query endpoint (handler-first orchestration)
app.post("/api/agent/query", async (req: Request, res: Response): Promise<void> => {
  const { message, context } = req.body as AgentToolRequest;
  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }

  let attemptedAction: AgentAction = inferActionFromMessage(message);

  try {
    const decision = await getAgentDecision(message, context);
    const params = (decision.params ?? {}) as Record<string, unknown>;
    const action = decision.action;
    attemptedAction = action;

    if (action === "fetch_doctors") {
      const doctorsRaw = await localGet("/api/doctors", {
        city: asNonEmptyString(params.city) ?? asNonEmptyString(context?.city) ?? "",
        specialty: asNonEmptyString(params.specialty) ?? asNonEmptyString(context?.specialty) ?? "",
        name: asNonEmptyString(params.doctorName) ?? asNonEmptyString(context?.doctorName) ?? "",
      });

      res.json({
        action,
        mapped: mapDoctorsForAgent(doctorsRaw),
      });
      return;
    }

    if (action === "get_live_slots") {
      const resourceIdInput = asNonEmptyString(params.resourceId) ?? asNonEmptyString(context?.resourceId);
      let locationIdInput = asNonEmptyString(params.locationId) ?? asNonEmptyString(context?.locationId);
      let regionIdInput = asNonEmptyString(params.regionId) ?? asNonEmptyString(context?.regionId) ?? "5";

      let resourceId = resourceIdInput;

      if (!resourceId) {
        const doctorsRaw = await localGet("/api/doctors", {
          city: asNonEmptyString(params.city) ?? asNonEmptyString(context?.city) ?? "",
          specialty: asNonEmptyString(params.specialty) ?? asNonEmptyString(context?.specialty) ?? "",
          name: asNonEmptyString(params.doctorName) ?? asNonEmptyString(context?.doctorName) ?? "",
        });
        const mappedDoctors = mapDoctorsForAgent(doctorsRaw);
        const firstDoctor = mappedDoctors.doctors[0];
        resourceId = firstDoctor?.resourceId ?? firstDoctor?.resourceIds?.[0];
        locationIdInput = locationIdInput ?? firstDoctor?.locationId;
        regionIdInput = regionIdInput ?? firstDoctor?.regionId ?? "5";
      }

      if (!resourceId) {
        res.status(400).json({ error: "resourceId missing and no matching doctor found" });
        return;
      }

      const city = asNonEmptyString(params.city) ?? asNonEmptyString(context?.city);
      const branch = asNonEmptyString(params.branch) ?? asNonEmptyString(context?.branch);
      const datesRaw = await localPost("/api/edoc/calendar-dates", {
        resourceId,
        locationId: locationIdInput,
        regionId: regionIdInput,
        city,
        branch,
      }, INTERNAL_EDOC_TOOL_TIMEOUT_MS);
      const mappedDates = mapCalendarDatesForAgent(datesRaw);
      const selectedDate = asNonEmptyString(params.date) ?? mappedDates.dates[0]?.edoc;

      if (!selectedDate) {
        res.json({
          action,
          resourceId,
          locationId: mappedDates.locationId ?? locationIdInput,
          liveDates: mappedDates,
          liveSlots: { slots: [], serviceBySlot: {}, defaultServiceId: null },
          note: "No live dates available for this doctor",
        });
        return;
      }

      const slotsRaw = await localPost("/api/edoc/slots-v2", {
        resourceId,
        locationId: mappedDates.locationId ?? locationIdInput,
        regionId: regionIdInput,
        date: selectedDate,
        city,
        branch,
      }, INTERNAL_EDOC_TOOL_TIMEOUT_MS);

      res.json({
        action,
        resourceId,
        locationId: mappedDates.locationId ?? locationIdInput,
        liveDates: mappedDates,
        selectedDate,
        liveSlots: mapSlotsForAgent(slotsRaw),
      });
      return;
    }

    if (action === "book_appointment") {
      const bookingPayload = (params.bookingPayload as Record<string, unknown>) ??
        (context?.bookingPayload as Record<string, unknown>) ??
        {};
      const bookingRaw = await localPost("/api/agent/book-appointment", bookingPayload);
      res.json({
        action,
        mapped: mapBookAppointmentForAgent(bookingRaw),
        raw: bookingRaw,
      });
      return;
    }

    res.json({ action: "unknown", note: "Could not infer a supported tool action from this message" });
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data?: unknown } };
    const errorText = String(e.message ?? "");
    const inferredAction = inferActionFromMessage(message);
    const contextResource = asNonEmptyString(context?.resourceId);
    const contextLocation = asNonEmptyString(context?.locationId);
    const action = attemptedAction !== "unknown"
      ? attemptedAction
      : inferredAction !== "unknown"
      ? inferredAction
      : contextResource || contextLocation
      ? "get_live_slots"
      : "unknown";

    const status = /timeout/i.test(errorText) ? 504 : 500;
    res.status(status).json({
      error: e.response?.data ?? e.message ?? "agent query failed",
      action,
    });
  }
});

// 1e. Book appointment tool for LLM agent (POST wrapper)
app.post("/api/agent/book-appointment", async (req: Request, res: Response): Promise<void> => {
  const payload = req.body as Record<string, unknown>;
  try {
    const bookingRaw = await localPost("/api/edoc/book-appointment", payload);
    res.json(bookingRaw);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data?: unknown; status?: number } };
    const status = e.response?.status ?? 500;
    res.status(status).json({
      error: e.response?.data ?? e.message ?? "book appointment tool failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Apollo EDOC API proxy routes  (AuthKey stays server-side) ────────────────
// ─────────────────────────────────────────────────────────────────────────────

// 2. Book Appointment
app.post("/api/edoc/book-appointment", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.ResourceID || !b.StartDateTime || !b.LocationID || !b.UHIDNumber) {
    res.status(400).json({ error: "ResourceID, StartDateTime, LocationID, UHIDNumber required" });
    return;
  }
  if (!isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }
  try {
    logEdoc("BookAppointment.request", b);
    const r = await axios.post(`${EDOC_BASE}/api/EDOC/BookAppointment`, b, { headers: edocHeaders(), timeout: 15000 });
    logEdoc("BookAppointment.response", r.data);
    console.log("[EDOC] BookAppointment succeeded (200 OK)");
    res.json(r.data);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    logEdoc("BookAppointment.error", { message: e.message, response: e.response?.data });
    res.status(500).json({ error: e.response?.data ?? e.message ?? "BookAppointment failed" });
  }
});

// 3. Reschedule Appointment
app.post("/api/edoc/reschedule-appointment", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.AppointmentID || !b.StartDateTime) {
    res.status(400).json({ error: "AppointmentID and StartDateTime required" });
    return;
  }
  if (b.LocationID !== undefined && b.LocationID !== null && !isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }
  try {
    const r = await axios.post(`${EDOC_BASE}/api/EDOC/ResheduleAppointment`, b, { headers: edocHeaders(), timeout: 15000 });
    console.log("[EDOC] ResheduleAppointment succeeded (200 OK)");
    res.json(r.data);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    res.status(500).json({ error: e.response?.data ?? e.message ?? "ResheduleAppointment failed" });
  }
});

// 4. Cancel Appointment
app.post("/api/edoc/cancel-appointment", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.AppointmentID || !b.LocationID) {
    res.status(400).json({ error: "AppointmentID and LocationID required" });
    return;
  }
  if (!isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }
  try {
    const r = await axios.post(`${EDOC_BASE}/api/EDOC/CancelAppointment`, b, { headers: edocHeaders(), timeout: 15000 });
    console.log("[EDOC] CancelAppointment succeeded (200 OK)");
    res.json(r.data);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    res.status(500).json({ error: e.response?.data ?? e.message ?? "CancelAppointment failed" });
  }
});

// 5. Fetch Real-time Slots (DoctorCalenderRules)
app.post("/api/edoc/slots", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, date, city, branch } = req.body as Record<string, string>;
  if (!resourceId || !date) {
    res.status(400).json({ error: "resourceId and date required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({ slots: [], retcode: -1, error: "No valid locationId available" });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        logEdoc("DoctorCalenderRules.request", { resourceId, locationId: locId, regionId: resolveRegionId(branch, regionId), date });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/DoctorCalenderRules`,
          { RegionID: resolveRegionId(branch, regionId), Locationid: locId, ResourceID: resourceId, ID_Date: date },
          { headers: edocHeaders(), timeout: 15000 }
        );
        logEdoc("DoctorCalenderRules.response", r.data);
        const raw = (r.data as { getDoctorCalenderRulesDetails?: string; retcode?: number }).getDoctorCalenderRulesDetails ?? "";
        const allRawSlots = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (isFakeSchedule(allRawSlots)) {
          logEdoc("DoctorCalenderRules.fake_schedule", { resourceId, locationId: locId, slotsCount: allRawSlots.length, firstSlot: allRawSlots[0] });
          lastError = "fake schedule";
          continue; // try next location candidate
        }
        const slots = allRawSlots.filter((s) => s >= "07:00" && s <= "21:00");
        res.status(200).json({ slots, retcode: (r.data as { retcode?: number }).retcode ?? 0, locationId: locId });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("DoctorCalenderRules.error", { message: ie.message, resourceId, locationId: locId, date });
        lastError = ie.message ?? "DoctorCalenderRules failed";
      }
    }

    res.status(200).json({ slots: [], retcode: -1, error: lastError || "DoctorCalenderRules failed" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({ error: e.message ?? "DoctorCalenderRules failed", slots: [], retcode: -1 });
  }
});

// 6. Fetch Real-time Slots V2 (DoctorCalenderRules_V2)
app.post("/api/edoc/slots-v2", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, date, city, branch } = req.body as Record<string, string>;
  if (!resourceId || !date) {
    res.status(400).json({ error: "resourceId and date required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({
      services: [],
      allSlots: [],
      slotToServiceId: {},
      defaultServiceId: null,
      retcode: -1,
      error: "No valid locationId available",
    });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        logEdoc("DoctorCalenderRules_V2.request", { resourceId, locationId: locId, regionId: resolveRegionId(branch, regionId), date });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/DoctorCalenderRules_V2`,
          { RegionID: resolveRegionId(branch, regionId), Locationid: locId, ResourceID: resourceId, ID_Date: date },
          { headers: edocHeaders(), timeout: 15000 }
        );
        logEdoc("DoctorCalenderRules_V2.response", r.data);

        const body = r.data as {
          getDoctorNewRulesDetails?: Array<{
            serviceid?: string | number;
            servicedetail?: Array<{
              requestdate?: string;
              starttime?: string;
              endtime?: string;
              slotinterval?: string | number;
              maxslot?: string | number;
              split_slots?: string;
            }>;
          }>;
          retcode?: number;
          Message?: string | null;
        };

        const serviceRows = Array.isArray(body.getDoctorNewRulesDetails) ? body.getDoctorNewRulesDetails : [];
        const services = serviceRows
          .map((row) => {
            const serviceId = String(row.serviceid ?? "").trim();
            const details = Array.isArray(row.servicedetail) ? row.servicedetail : [];
            const requestDate = String(details[0]?.requestdate ?? "").trim();
            const startTime = String(details[0]?.starttime ?? "").trim();
            const endTime = String(details[0]?.endtime ?? "").trim();
            const slotInterval = String(details[0]?.slotinterval ?? "").trim();
            const maxSlot = String(details[0]?.maxslot ?? "").trim();

            const slotSet = new Set<string>();
            details.forEach((d) => {
              const split = String(d.split_slots ?? "");
              split.split(",").forEach((value) => {
                const slot = value.trim();
                if (slot) slotSet.add(slot);
              });
            });

            return {
              serviceId,
              requestDate,
              startTime,
              endTime,
              slotInterval,
              maxSlot,
              slots: Array.from(slotSet),
            };
          })
          .filter((row) => row.serviceId.length > 0);

        const slotToServiceId: Record<string, string> = {};
        const allSlotsSet = new Set<string>();
        services.forEach((service) => {
          service.slots.forEach((slot) => {
            allSlotsSet.add(slot);
            if (!slotToServiceId[slot]) slotToServiceId[slot] = service.serviceId;
          });
        });

        const isReasonableSlot = (t: string) => t >= "07:00" && t <= "21:00";
        const allSlots = Array.from(allSlotsSet).filter(isReasonableSlot).sort((a, b) => a.localeCompare(b));
        if (isFakeSchedule(Array.from(allSlotsSet))) {
          logEdoc("DoctorCalenderRules_V2.fake_schedule", { resourceId, locationId: locId, slotsCount: allSlotsSet.size, firstSlot: Array.from(allSlotsSet).sort()[0] });
          lastError = "fake schedule";
          continue; // try next location candidate
        }
        res.status(200).json({
          services,
          allSlots,
          slotToServiceId,
          defaultServiceId: services[0]?.serviceId ?? null,
          retcode: body.retcode ?? 0,
          locationId: locId,
          message: body.Message ?? null,
        });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("DoctorCalenderRules_V2.error", { message: ie.message, resourceId, locationId: locId, date });
        lastError = ie.message ?? "DoctorCalenderRules_V2 failed";
      }
    }

    res.status(200).json({
      services: [],
      allSlots: [],
      slotToServiceId: {},
      defaultServiceId: null,
      retcode: -1,
      error: lastError || "DoctorCalenderRules_V2 failed",
    });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({
      services: [],
      allSlots: [],
      slotToServiceId: {},
      defaultServiceId: null,
      retcode: -1,
      error: e.message ?? "DoctorCalenderRules_V2 failed",
    });
  }
});

// 7. Get Calendar Details for Online (Medmantra sync)
app.post("/api/edoc/calendar-details", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, date, city, branch } = req.body as Record<string, string>;
  if (!resourceId) {
    res.status(400).json({ error: "resourceId required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({ calendar: [], retcode: -1, error: "No valid locationId available" });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        const xmlReq = `<ResourceDetails><Resource ResourceID = '${resourceId}' LocationID='${locId}' /></ResourceDetails>`;
        logEdoc("GetCalendardetailsforOnline.request", {
          resourceId,
          locationId: locId,
          regionId: resolveRegionId(branch, regionId),
          date: date ?? "",
        });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/GetCalendardetailsforOnline`,
          { ixmlcalendarrequest: xmlReq, ID_Date: date ?? "", RegionID: resolveRegionId(branch, regionId) },
          { headers: edocHeaders(), timeout: 15000 }
        );
        logEdoc("GetCalendardetailsforOnline.response", r.data);
        const body = r.data as { getCalendarList?: unknown[]; retcode?: number; Message?: string | null };
        const calendar = Array.isArray(body.getCalendarList) ? body.getCalendarList : [];
        res.status(200).json({
          calendar,
          retcode: body.retcode ?? 0,
          locationId: locId,
          message: body.Message ?? null,
        });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("GetCalendardetailsforOnline.error", { message: ie.message, resourceId, locationId: locId, date });
        lastError = ie.message ?? "GetCalendardetailsforOnline failed";
      }
    }

    res.status(200).json({ calendar: [], retcode: -1, error: lastError || "GetCalendardetailsforOnline failed" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({ calendar: [], retcode: -1, error: e.message ?? "GetCalendardetailsforOnline failed" });
  }
});

// 8. Pull UHID by mobile number
app.post("/api/edoc/uhid-search", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { phone, regionId, uhidNumber } = req.body as Record<string, string>;
  const normalizedPhone = String(phone ?? "").replace(/[^0-9+]/g, "");
  if (!normalizedPhone) {
    res.status(400).json({ error: "phone required" });
    return;
  }
  // Validate phone – only digits and optional leading +
  if (!/^\+?[0-9]{10,13}$/.test(normalizedPhone)) {
    res.status(400).json({ error: "Invalid phone number format" });
    return;
  }
  try {
    const r = await axios.post(
      `${EDOC_BASE}/api/EDOC/GetUHID`,
      { MobileNumber: normalizedPhone, RegionID: Number(regionId ?? "5"), UHIDNumber: uhidNumber ?? "" },
      { headers: edocHeaders(), timeout: 15000 }
    );
    const data = r.data as { getUHIDList?: unknown[]; retcode?: number };
    res.json({ uhidList: data.getUHIDList ?? [], retcode: data.retcode ?? 0 });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(500).json({ error: e.message ?? "GetUHID failed", uhidList: [] });
  }
});

// 9. Doctor Calendar Live Dates
app.post("/api/edoc/calendar-dates", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, city, branch } = req.body as Record<string, string>;
  if (!resourceId) {
    res.status(400).json({ error: "resourceId required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({ dates: [], retcode: -1, error: "No valid locationId available" });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        logEdoc("DoctorCalenderLiveDates.request", { resourceId, locationId: locId, regionId: resolveRegionId(branch, regionId) });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/DoctorCalenderLiveDates`,
          { RegionID: resolveRegionId(branch, regionId), Locationid: locId, ResourceID: resourceId },
          { headers: edocHeaders(), timeout: 15000 }
        );
        logEdoc("DoctorCalenderLiveDates.response", r.data);
        const raw = (r.data as { Dates?: string; retcode?: number }).Dates ?? "";
        const retcode = (r.data as { retcode?: number }).retcode ?? 0;
        // Convert D/M/YYYY format → EDOC format "DD-MON-YYYY" + keep original for display
        const dates = raw
          ? raw.split(",").map((d) => ({ display: d.trim(), edoc: toEdocDate(d.trim()) })).slice(0, 30)
          : [];
        if (dates.length === 0) {
          logEdoc("DoctorCalenderLiveDates.no_live_dates", {
            resourceId,
            requestedLocationId: locationId ?? null,
            resolvedLocationId: locId,
            regionId: resolveRegionId(branch, regionId),
            city: city ?? null,
            retcode,
            rawDates: raw,
            reason: "EDOC returned empty Dates",
          });
        }
        res.status(200).json({ dates, retcode, locationId: locId });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("DoctorCalenderLiveDates.error", { message: ie.message, resourceId, locationId: locId });
        lastError = ie.message ?? "DoctorCalenderLiveDates failed";
      }
    }

    res.status(200).json({ dates: [], retcode: -1, error: lastError || "DoctorCalenderLiveDates failed" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({ error: e.message ?? "DoctorCalenderLiveDates failed", dates: [], retcode: -1 });
  }
});

// 10. Generate UHID Online
app.post("/api/edoc/generate-uhid", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.FirstName || !b.MobileNumber || !b.LocationID) {
    res.status(400).json({ error: "FirstName, MobileNumber, LocationID required" });
    return;
  }
  if (!isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }
  try {
    const r = await axios.post(`${EDOC_BASE}/api/EDOC/GenerateUHIDOnline`, b, { headers: edocHeaders(), timeout: 15000 });
    const data = r.data as { result?: string; retcode?: number };
    res.json({ uhid: data.result ?? "", retcode: data.retcode ?? 0 });
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    res.status(500).json({ error: e.response?.data ?? e.message ?? "GenerateUHIDOnline failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── All-Branch Doctor Search via Gemini Tool Calling ─────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface DoctorSearchRequest {
  message: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}

/**
 * POST /api/doctor-search
 *
 * Flow:
 * 1. Send user message + searchDoctors tool schema to Gemini
 * 2. If Gemini issues a tool call → execute searchDoctors(query) locally
 * 3. Return tool result to Gemini for a grounded natural-language response
 * 4. Respond with { text, doctors }
 *
 * LLM NEVER invents doctor data. All results come from local full-dataset retrieval.
 */
app.post("/api/doctor-search", async (req: Request, res: Response): Promise<void> => {
  const { message, history } = (req.body ?? {}) as DoctorSearchRequest;

  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    // Fallback: run fuzzy search directly and return without LLM narrative
    const fallbackDoctors = searchDoctors(message);
    res.json({
      text: fallbackDoctors.length > 0
        ? `Found ${fallbackDoctors.length} doctor(s) matching your query.`
        : "No doctors found matching your query.",
      doctors: fallbackDoctors,
    });
    return;
  }

  const SYSTEM_PROMPT = `You are a hospital assistant for Apollo Hospitals India.

STRICT RULES:
- If the user mentions any doctor name, specialty, department, or medical term, you MUST call the "searchDoctors" tool.
- NEVER answer doctor queries from your training data or memory.
- NEVER hallucinate or invent doctor names or specialties.
- EVEN IF the input is misspelled or partial, STILL call the tool.
- Infer city/branch from user text when present and pass them to the tool as filters.
- After receiving tool results, respond naturally using ONLY those results.
- If no results are returned, say "No matching doctors found" and suggest broadening the search.

Examples of when to call the tool:
"dr ramesh" → call searchDoctors
"cardiologist" → call searchDoctors
"ent doctor" → call searchDoctors
"skin doctor in hyderabad" → call searchDoctors with city="Hyderabad"
"ramsh" (misspelled) → call searchDoctors`;

  try {
    const geminiModel = "gemini-2.0-flash";
    console.log(`[doctor-search] Gemini tool-calling with message: "${message}"`);

    const model = genAI.getGenerativeModel({
      model: geminiModel,
      systemInstruction: SYSTEM_PROMPT,
      tools: [
        {
          functionDeclarations: [SEARCH_DOCTORS_TOOL],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.AUTO,
        },
      },
    });

    const chat = model.startChat({
      history: (history ?? []).slice(-6).map((h) => ({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: h.text }],
      })),
    });

    // Round 1: send user message; Gemini may issue a tool call
    const round1 = await chat.sendMessage(message);
    const round1Parts = round1.response.candidates?.[0]?.content?.parts ?? [];

    // Check for a function call in the response
    const fnCallPart = round1Parts.find((p) => p.functionCall);

    if (fnCallPart?.functionCall) {
      const fnName = fnCallPart.functionCall.name;
      const fnArgs = (fnCallPart.functionCall.args ?? {}) as Record<string, unknown>;

      console.log(`[doctor-search] Tool call: ${fnName}`, fnArgs);

      let toolResult: unknown = [];
      if (fnName === "searchDoctors") {
        const query = String(fnArgs.query ?? "").trim();
        const city = String(fnArgs.city ?? "").trim() || undefined;
        const branch = String(fnArgs.branch ?? "").trim() || undefined;
        const requestedLimit = Number(fnArgs.limit ?? 8);
        const limit = Number.isFinite(requestedLimit)
          ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
          : 8;
        toolResult = searchDoctors(query, city, branch, limit);
      }

      console.log(`[doctor-search] Tool result count:`, Array.isArray(toolResult) ? toolResult.length : "n/a");

      // Round 2: return tool result to Gemini for final grounded response
      const round2 = await chat.sendMessage([
        {
          functionResponse: {
            name: fnName,
            response: { result: toolResult },
          },
        },
      ]);

      const finalText = round2.response.text().trim();
      res.json({ text: finalText, doctors: toolResult });
      return;
    }

    // Gemini responded directly (no tool call needed — e.g., general question)
    const directText = round1.response.text().trim();
    res.json({ text: directText, doctors: [] });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("[doctor-search] Error:", e.message ?? err);
    // Graceful fallback: run fuzzy search without LLM narrative
    const fallbackDoctors = searchDoctors(message);
    res.json({
      text: fallbackDoctors.length > 0
        ? `Found ${fallbackDoctors.length} doctor(s) matching your query.`
        : "No doctors found matching your query.",
      doctors: fallbackDoctors,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Patient Memory Endpoints (SQLite-backed) ──────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface PatientLookupRequest {
  mobile?: string;
  uhid?: string;
  name?: string;
  dob?: string;
}

interface PatientRegisterRequest {
  name: string;
  mobile: string;
  dob: string;
}

interface SaveAppointmentRequest {
  mobile: string;
  appointmentId?: string;
  doctorName?: string;
  date?: string;
  slot?: string;
  status?: string;
}

/**
 * POST /api/patient/lookup
 * Check if a patient exists by mobile, UHID, or name+DOB.
 * Returns { found: true, patient } or { found: false }.
 */
app.post("/api/patient/lookup", (req: Request, res: Response): void => {
  const { mobile, uhid, name, dob } = (req.body ?? {}) as PatientLookupRequest;

  if (!mobile && !uhid && !(name && dob)) {
    res.status(400).json({ error: "Provide mobile, uhid, or both name and dob" });
    return;
  }

  console.log(`[patient/lookup] mobile=${mobile ?? "-"} uhid=${uhid ?? "-"} name=${name ?? "-"}`);

  const patient = findPatient(mobile, uhid, name, dob);
  if (patient) {
    res.json({ found: true, patient });
  } else {
    res.json({ found: false });
  }
});

/**
 * POST /api/patient/register
 * Create a new patient record. Returns the created patient with generated UHID.
 * If mobile already registered, returns the existing record (idempotent).
 */
app.post("/api/patient/register", (req: Request, res: Response): void => {
  const { name, mobile, dob } = (req.body ?? {}) as PatientRegisterRequest;

  if (!name || !mobile || !dob) {
    res.status(400).json({ error: "name, mobile, and dob are required" });
    return;
  }

  // Basic format validation for dob (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob.trim())) {
    res.status(400).json({ error: "dob must be in YYYY-MM-DD format" });
    return;
  }

  console.log(`[patient/register] name=${name} mobile=${mobile} dob=${dob}`);

  try {
    const patient = registerPatient(name, mobile, dob);
    res.json({ patient });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("[patient/register] Error:", e.message ?? err);
    res.status(500).json({ error: e.message ?? "Failed to register patient" });
  }
});

/**
 * POST /api/patient/appointment
 * Save a confirmed appointment for an existing patient (looked up by mobile).
 */
app.post("/api/patient/appointment", (req: Request, res: Response): void => {
  const { mobile, appointmentId, doctorName, date, slot, status } = (req.body ?? {}) as SaveAppointmentRequest;

  if (!mobile) {
    res.status(400).json({ error: "mobile is required" });
    return;
  }

  const patient = findPatient(mobile);
  if (!patient) {
    res.status(404).json({ error: "Patient not found. Register the patient first." });
    return;
  }

  console.log(`[patient/appointment] patientId=${patient.id} doctor=${doctorName ?? "-"} date=${date ?? "-"}`);

  try {
    const appt = saveAppointment(
      patient.id,
      appointmentId ?? null,
      doctorName ?? null,
      date ?? null,
      slot ?? null,
      status ?? "confirmed"
    );
    res.json({ appointment: appt });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("[patient/appointment] Error:", e.message ?? err);
    res.status(500).json({ error: e.message ?? "Failed to save appointment" });
  }
});

/**
 * POST /api/patient/details
 * Retrieve the most recent appointment + patient info.
 * Returns { found: true, record } or { found: false }.
 *
 * ONLY retrieves data when user explicitly asks.
 * NEVER returns all records.
 */
app.post("/api/patient/details", (req: Request, res: Response): void => {
  const { mobile, uhid, name, dob } = (req.body ?? {}) as PatientLookupRequest;

  if (!mobile && !uhid && !(name && dob)) {
    res.status(400).json({ error: "Provide mobile, uhid, or both name and dob" });
    return;
  }

  console.log(`[patient/details] mobile=${mobile ?? "-"} uhid=${uhid ?? "-"} name=${name ?? "-"}`);

  const record = getLatestPatientAppointment(mobile, uhid, name, dob);

  if (record) {
    res.json({ found: true, record });
  } else {
    res.json({ found: false, message: "No appointment found. Would you like to book one?" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Agent Orchestration Decision  (POST /api/agent/decide) ───────────────────
// The LLM proposes a structured action; XState + tools execute it safely.
// The LLM NEVER touches EDOC APIs, patient DB, or auth keys.
// ─────────────────────────────────────────────────────────────────────────────

export type AgentDecisionAction =
  | "CONTINUE_WORKFLOW"
  | "SWITCH_WORKFLOW"
  | "CALL_TOOL"
  | "ASK_CLARIFICATION"
  | "RESET_FLOW";

export interface AgentDecision {
  action: AgentDecisionAction;
  /** One of the valid workflow names, or null for CONTINUE_WORKFLOW/ASK_CLARIFICATION */
  targetWorkflow: string | null;
  /** Human-readable reason; also used as the clarification question for ASK_CLARIFICATION */
  reason: string;
  /** 0–1 confidence; values below 0.6 cause the frontend to fall back to deterministic handling */
  confidence: number;
  /** Entities extracted ONLY from the CURRENT user message — never copied from session context */
  entities: {
    doctorName: string | null;
    specialty: string | null;
    city: string | null;
    branch: string | null;
    symptomText: string | null;
  };
}

interface AgentDecideRequest {
  currentState?: string;
  machineContext?: Record<string, string | undefined>;
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  summary?: string;
  /** ISO 639-1 language code detected from the user's messages (e.g. "te", "hi"). */
  userLanguage?: string;
}

/** Normalise an entity value: empty strings / undefined → null */
function sanitizeEntity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

const AGENT_DECIDE_FALLBACK: AgentDecision = {
  action: "CONTINUE_WORKFLOW",
  targetWorkflow: null,
  reason: "Fallback — continuing current workflow",
  confidence: 1,
  entities: { doctorName: null, specialty: null, city: null, branch: null, symptomText: null },
};

const VALID_AGENT_ACTIONS: AgentDecisionAction[] = [
  "CONTINUE_WORKFLOW", "SWITCH_WORKFLOW", "CALL_TOOL", "ASK_CLARIFICATION", "RESET_FLOW",
];

/**
 * POST /api/agent/decide
 *
 * Analyses the user's message in session context and returns a structured AgentDecision.
 * The frontend uses this to decide whether to continue the current XState workflow,
 * switch to a different one, trigger a tool call, ask for clarification, or reset.
 *
 * Security contract:
 *   - This endpoint ONLY reasons about intent and entities.
 *   - It NEVER calls EDOC APIs, reads/writes patient DB, or returns auth credentials.
 *   - All transactional execution happens in the XState machine + dedicated API routes.
 */
app.post("/api/agent/decide", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) {
    res.json(AGENT_DECIDE_FALLBACK);
    return;
  }

  const payload = (req.body ?? {}) as AgentDecideRequest;
  const {
    currentState: botState = "MAIN_MENU",
    machineContext = {},
    userMessage,
    history = [],
    summary = "",
    userLanguage = "",
  } = payload;

  if (!userMessage?.trim()) {
    res.status(400).json({ error: "userMessage required" });
    return;
  }

  const ctx = machineContext as Record<string, string | undefined>;

  // Build a concise description of current session state for the LLM
  const contextLines = [
    `Bot state: ${botState}`,
    ctx.doctorName  ? `Doctor in context: ${ctx.doctorName}`  : null,
    ctx.specialty   ? `Specialty in context: ${ctx.specialty}` : null,
    ctx.city        ? `City in context: ${ctx.city}`           : null,
    ctx.branch      ? `Branch in context: ${ctx.branch}`       : null,
    ctx.symptomText ? `Symptom in context: ${ctx.symptomText}` : null,
  ].filter(Boolean).join("\n");

  const summaryBlock = summary.trim()
    ? `\nConversation so far:\n${summary}\n`
    : "";

  const systemPrompt = `You are the conversational orchestrator for Apollo Assist, a healthcare chatbot for Apollo Hospitals India.

Your job: analyse the user's latest message in context and return the single best next action as a JSON object.

=== CURRENT SESSION ===
${contextLines}${summaryBlock}

=== VALID TARGET WORKFLOWS ===
BOOK_BY_NAME       — user wants a specific doctor by name
BOOK_BY_SPECIALTY  — user wants doctors of a given specialty (e.g. Cardiology, ENT)
SYMPTOM_TRIAGE     — user describes a symptom; needs a specialty/doctor recommendation
BOOK_BY_LOCATION   — user wants to search by hospital/city first
FIND_DOCTOR        — general doctor discovery
CHANGE_DOCTOR      — user is viewing doctor cards and wants a DIFFERENT specific doctor (use with CALL_TOOL)
HEALTH_CHECKUP     — user wants a health or wellness package
EMERGENCY          — medical emergency
MAIN_MENU          — user wants to reset or return to the main menu

=== ACTION RULES ===
CONTINUE_WORKFLOW  — user is supplying the expected input for the current bot state (e.g. providing their city when asked for city, entering a name when prompted). Also use for purely social/conversational messages (greetings, "how are you", "thanks", small talk) — the frontend will handle these with a warm LLM response. Use when message fits the current state naturally. Confidence ≥ 0.7.
IMPORTANT EXCEPTION: If the bot state is ASK_BASIC_DETAILS or SELECT_SYMPTOM_CATEGORY and the user types a medical symptom or condition (e.g. "fever", "headache", "knee pain", "cold", "body ache"), use SYMPTOM_TRIAGE — NOT CONTINUE_WORKFLOW. Extract symptomText from the user's message.
SWITCH_WORKFLOW    — user changes direction mid-conversation (e.g. in ENTER_DOCTOR_NAME they say "show cardiologists"). Confidence must be ≥ 0.6 to switch.
CALL_TOOL          — user wants live data or a card swap within the current flow (e.g. viewing cards and asking for a different doctor). Confidence ≥ 0.6.
ASK_CLARIFICATION  — intent is too ambiguous to act on. Set reason = a warm, kind clarifying question to display to the user (e.g. "I'd love to help! Could you let me know which city you're in?").
RESET_FLOW         — user explicitly wants to start over, go back, or visit the main menu.

=== ENTITY EXTRACTION RULES (CRITICAL) ===
• Extract ONLY entities explicitly stated in the CURRENT user message.
• Do NOT copy entities from the session context above into your output.
• null means the user did not say it right now — the frontend will NOT inherit the old stale value.
• Exception: CONTINUE_WORKFLOW may have all-null entities (the value flows through the deterministic state machine).
• Specialty: use Apollo specialty names (e.g. "Cardiology", "ENT", "Orthopaedics", "Dermatology", "Neurology", "Gynaecology", "Paediatrics", "Gastroenterology", "Urology", "Oncology").
• City: use the city name as the user typed it.
• If the user says "switch to Chennai" — set city:"Chennai", leave specialty/branch null.
• If the user says "actually I want Cardiology" — set specialty:"Cardiology", leave city/branch null.

=== CONFIDENCE SCALE ===
0.9  Very clear ("show cardiologists in Hyderabad")
0.7  Likely but minor ambiguity
0.5  Ambiguous → use CONTINUE_WORKFLOW or ASK_CLARIFICATION
< 0.5  Never use SWITCH_WORKFLOW or CALL_TOOL

Return ONLY a valid JSON object — no markdown, no extra text:
{
  "action": "CONTINUE_WORKFLOW" | "SWITCH_WORKFLOW" | "CALL_TOOL" | "ASK_CLARIFICATION" | "RESET_FLOW",
  "targetWorkflow": string | null,
  "reason": string,
  "confidence": number,
  "entities": {
    "doctorName": string | null,
    "specialty": string | null,
    "city": string | null,
    "branch": string | null,
    "symptomText": string | null
  }
}${userLanguage && userLanguage !== "en" ? `

=== LANGUAGE ===
The user's interface language is "${userLanguage}". When action is ASK_CLARIFICATION, write the "reason" field in the user's language (not English).` : ""}`;

  console.log(`[AGENT/decide] state="${botState}" message="${userMessage}"`);

  try {
    const recentHistory = history.slice(-8);
    const raw = stripMarkdownJson(
      await callLlm(systemPrompt, `User message: "${userMessage}"`, recentHistory)
    );
    const parsed = JSON.parse(raw) as AgentDecision;

    if (!parsed || !VALID_AGENT_ACTIONS.includes(parsed.action)) {
      console.warn("[AGENT/decide] Invalid action in LLM response, falling back:", JSON.stringify(parsed));
      res.json(AGENT_DECIDE_FALLBACK);
      return;
    }

    const rawEntities = (parsed.entities ?? {}) as Record<string, unknown>;
    const decision: AgentDecision = {
      action: parsed.action,
      targetWorkflow:
        typeof parsed.targetWorkflow === "string" && parsed.targetWorkflow.trim()
          ? parsed.targetWorkflow.trim()
          : null,
      reason: String(parsed.reason ?? ""),
      confidence:
        typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      entities: {
        doctorName:  sanitizeEntity(rawEntities.doctorName),
        specialty:   sanitizeEntity(rawEntities.specialty),
        city:        sanitizeEntity(rawEntities.city),
        branch:      sanitizeEntity(rawEntities.branch),
        symptomText: sanitizeEntity(rawEntities.symptomText),
      },
    };

    console.log(
      `[AGENT/decide] → action="${decision.action}" workflow="${decision.targetWorkflow ?? "-"}" ` +
      `confidence=${decision.confidence} reason="${decision.reason}"`
    );
    res.json(decision);
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.warn("[AGENT/decide] LLM parse/call error, falling back:", e.message ?? err);
    res.json(AGENT_DECIDE_FALLBACK);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Apollo Assist backend running on http://localhost:${PORT}`);
});
