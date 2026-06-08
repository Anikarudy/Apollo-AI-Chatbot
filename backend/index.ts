/**
 * backend/index.ts
 *
 * Express application entry point — slim orchestrator only.
 *
 * Responsibilities:
 *   - App + middleware setup
 *   - Router mounting
 *   - /api/chat  (kept here: tightly coupled with LLM + audit + session logic)
 *   - /api/agent/* (tool-routing + internal localGet/localPost helpers)
 *   - Server startup + graceful shutdown (BullMQ worker + Redis lifecycle)
 *
 * All other routes  → backend/routes/*.routes.ts
 * All middleware    → backend/middleware/*.middleware.ts
 * All shared utils  → backend/lib/*.ts
 */

import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import axios from "axios";
import { FunctionCallingMode } from "@google/generative-ai";

import {
  buildDoctorSearchUrl,
  contacts,
  doctors,
} from "../frontend/src/knowledgeBase";
import {
  mapBookAppointmentForAgent,
  mapCalendarDatesForAgent,
  mapDoctorsForAgent,
  mapSlotsForAgent,
} from "./agentHandlers";
import { searchDoctors, SEARCH_DOCTORS_TOOL } from "./searchDoctors";
import { upsertSession } from "./services/chatSessionService";
import { logMessage } from "./services/chatMessageService";
import { logEvent } from "./services/auditService";
import { startAuditWorker, stopAuditWorker } from "./workers/auditWorker";
import { closeRedisConnection } from "./lib/redis";
import log from "./lib/logger";
import {
  callLlm,
  genAI,
  hasAnyLlm,
  NO_LLM_ERROR,
  stripMarkdownJson,
} from "./lib/llmClient";

// ── Middleware ────────────────────────────────────────────────────────────────
import { requestLoggerMiddleware } from "./middleware/requestLogger.middleware";
import { sessionMiddleware } from "./middleware/session.middleware";
import { generalLimiter, chatLimiter } from "./middleware/rateLimit.middleware";
import { requireInternalRouteAccess } from "./middleware/adminAuth.middleware";
import { maskSessionId } from "./lib/maskSensitiveData";

// ── Routers ───────────────────────────────────────────────────────────────────
import { healthRouter }  from "./routes/health.routes";
import { adminRouter }   from "./routes/admin.routes";
import { sessionRouter } from "./routes/session.routes";
import { intentRouter }  from "./routes/intent.routes";
import { doctorRouter }  from "./routes/doctor.routes";
import { edocRouter }    from "./routes/edoc.routes";
import { metricsRouter } from "./routes/metrics.routes";
import { toolRouter }    from "./routes/tool.routes";
import { uploadRouter }  from "./routes/upload.routes";

dotenv.config();

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();

const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const ngrokOrigin = String(process.env.NGROK_ORIGIN ?? "").trim();
if (ngrokOrigin) configuredOrigins.push(ngrokOrigin);
if (configuredOrigins.length === 0 && process.env.NODE_ENV !== "production") {
  configuredOrigins.push("http://localhost:5173", "http://127.0.0.1:5173");
}
const allowedOrigins = new Set(configuredOrigins);

if (allowedOrigins.size === 0) {
  log.warn("No allowed FRONTEND_ORIGIN configured; cross-origin browser requests will be blocked.");
}

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: false,
}));
app.use(express.json({ limit: "64kb" }));
app.use(generalLimiter);
app.use(requestLoggerMiddleware);
app.use(sessionMiddleware);

// ── Router mounting ───────────────────────────────────────────────────────────
app.use("/",          healthRouter);   // /health, /ready
app.use("/api",       intentRouter);   // /api/intent, /api/symptom-specialty, /api/detect-language, /api/translate-ui, /api/summarize, /api/log-interaction
app.use("/api",       doctorRouter);   // /api/doctors, /api/doctor-search
app.use("/api",       sessionRouter);  // /api/session/:id, /api/appointments/check
app.use("/api/edoc",  edocRouter);     // /api/edoc/*
app.use("/api",       toolRouter);     // /api/tools/mobile-verification
app.use("/api/uploads", uploadRouter); // /api/uploads/* (handshake + presigned upload)
app.use("/api/admin", adminRouter);    // /api/admin/session/:id
app.use("/api",       metricsRouter);  // /api/metrics (501 stub)

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);
const LOCAL_API_BASE = `http://127.0.0.1:${PORT}`;
const INTERNAL_TOOL_TIMEOUT_MS = 30_000;
const INTERNAL_EDOC_TOOL_TIMEOUT_MS = 90_000;

// ── Internal tool helpers (used by /api/agent/* routes) ──────────────────────
async function localGet(
  path: string,
  params: Record<string, unknown>,
  timeoutMs = INTERNAL_TOOL_TIMEOUT_MS,
): Promise<unknown> {
  const r = await axios.get(`${LOCAL_API_BASE}${path}`, { params, timeout: timeoutMs });
  return r.data;
}

async function localPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = INTERNAL_TOOL_TIMEOUT_MS,
): Promise<unknown> {
  const r = await axios.post(`${LOCAL_API_BASE}${path}`, body, { timeout: timeoutMs });
  return r.data;
}

// ── Agent types ───────────────────────────────────────────────────────────────
type AgentAction = "fetch_doctors" | "get_live_slots" | "book_appointment" | "unknown";

interface AgentToolRequest {
  message:  string;
  context?: Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return s.length > 0 ? s : undefined;
}

function inferActionFromMessage(message: string): AgentAction {
  if (/book|appointment|reserve|schedule/i.test(message)) return "book_appointment";
  if (/slot|live date|availability|available/i.test(message)) return "get_live_slots";
  if (/doctor|specialist|consult/i.test(message)) return "fetch_doctors";
  return "unknown";
}

async function getAgentDecision(
  message: string,
  context?: Record<string, unknown>,
): Promise<{ action: AgentAction; params?: Record<string, unknown> }> {
  if (!hasAnyLlm) return { action: inferActionFromMessage(message), params: context ?? {} };

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

  try {
    const raw    = stripMarkdownJson(
      await callLlm(systemPrompt, JSON.stringify({ message, context: context ?? {} })),
    );
    const parsed = JSON.parse(raw) as { action: AgentAction; params?: Record<string, unknown> };
    if (!parsed?.action) return { action: inferActionFromMessage(message), params: context ?? {} };

    const allowedActions: AgentAction[] = [
      "fetch_doctors", "get_live_slots", "book_appointment", "unknown",
    ];
    const parsedAction = allowedActions.includes(parsed.action) ? parsed.action : "unknown";
    const inferred     = inferActionFromMessage(message);
    const action       = parsedAction === "unknown" && inferred !== "unknown" ? inferred : parsedAction;
    return { action, params: parsed.params ?? context ?? {} };
  } catch {
    return { action: inferActionFromMessage(message), params: context ?? {} };
  }
}

// ── /api/agent/decide types ───────────────────────────────────────────────────
export type AgentDecisionAction =
  | "CONTINUE_WORKFLOW"
  | "SWITCH_WORKFLOW"
  | "CALL_TOOL"
  | "ASK_CLARIFICATION"
  | "RESET_FLOW";

export interface AgentDecision {
  action:         AgentDecisionAction;
  targetWorkflow: string | null;
  reason:         string;
  confidence:     number;
  entities: {
    doctorName:  string | null;
    specialty:   string | null;
    city:        string | null;
    branch:      string | null;
    symptomText: string | null;
  };
}

function sanitizeEntity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

const AGENT_DECIDE_FALLBACK: AgentDecision = {
  action:         "CONTINUE_WORKFLOW",
  targetWorkflow: null,
  reason:         "Fallback — continuing current workflow",
  confidence:     1,
  entities:       { doctorName: null, specialty: null, city: null, branch: null, symptomText: null },
};

const VALID_AGENT_ACTIONS: AgentDecisionAction[] = [
  "CONTINUE_WORKFLOW", "SWITCH_WORKFLOW", "CALL_TOOL", "ASK_CLARIFICATION", "RESET_FLOW",
];

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat (public-safe route)
// ─────────────────────────────────────────────────────────────────────────────
interface ChatRequest {
  currentState?:  string;
  context?:       Record<string, string | undefined>;
  userMessage?:   string;
  history?:       Array<{ role: "user" | "assistant"; text: string }>;
  summary?:       string;
  userLanguage?:  string;
  messageType?:   string;
  buttonLabel?:   string;
  buttonValue?:   string;
}

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

const CHAT_LANG_NAMES: Record<string, string> = {
  te: "Telugu", hi: "Hindi",   ta: "Tamil",  kn: "Kannada", ml: "Malayalam",
  gu: "Gujarati", bn: "Bengali", pa: "Punjabi", ur: "Urdu",   mr: "Marathi",
  or: "Odia",   si: "Sinhala",
};

app.post("/api/chat", chatLimiter, async (req: Request, res: Response): Promise<void> => {
  const payload       = (req.body ?? {}) as ChatRequest;
  const currentState  = String(payload.currentState ?? "MAIN_MENU");
  const context       = payload.context ?? {};
  const userMessage   = payload.userMessage;
  const summary       = (payload.summary ?? "").trim();
  const userLanguage  = String(payload.userLanguage ?? "").trim();
  const messageType   = payload.messageType;
  const buttonLabel   = payload.buttonLabel;
  const buttonValue   = payload.buttonValue;

  if (!hasAnyLlm) { res.status(503).json({ error: NO_LLM_ERROR }); return; }

  if (userMessage && INTERNAL_RE.some((r) => r.test(userMessage))) {
    res.json({ text: "I'm Apollo Assist, your dedicated health assistant for Apollo Hospitals. I can help with doctor searches, appointments, and healthcare information. How can I assist you today?" });
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
    `International: ${contacts.internationalEmail} | ${contacts.apolloLifelineInternational}`,
  ].join("\n");

  const detectedLangName = CHAT_LANG_NAMES[userLanguage] ?? "";
  const langHeader = detectedLangName
    ? `=== RESPONSE LANGUAGE: ${detectedLangName.toUpperCase()} ===\nYou MUST write your entire response in ${detectedLangName}. This is the highest-priority instruction.\n- The conversation history may contain English messages — that is irrelevant. Reply in ${detectedLangName} now.\n- Do NOT use English words except for: doctor names, hospital names, city/branch names, phone numbers, and medical specialty names. Everything else must be in ${detectedLangName}.\n- Do NOT add a translation, explanation, or language label.\n===\n`
    : "";

  const systemPrompt = `${langHeader}You are Apollo Assist, the warm and caring AI health companion for Apollo Hospitals India. Think of yourself as a knowledgeable friend — someone who listens, responds like a real person, and gently helps people get the healthcare they need.

${summary ? `Conversation summary (what has happened so far):\n${summary}\n\n` : ""}${kbContext}

How to respond:

CASUAL / SOCIAL MESSAGES (greetings, "how are you", "thanks", complaints, small talk):
- Respond like a warm human would.
- IMPORTANT: Only talk about your own wellbeing (for example "I'm doing well") when the user explicitly asks "how are you" or an equivalent.
- For simple greetings like "hi" or "hello", greet back naturally and do NOT imply the user asked about your wellbeing.
- If someone says you're not kind, apologise sincerely and warmly. If someone says thanks, respond with heart.
- After engaging authentically, GENTLY transition — like a friend who says "by the way, is there anything I can help you with today?". Keep it soft, not salesy.
- Never respond to "how are you" with "How can I help you with Apollo Hospitals today?" — that is robotic and cold.

HEALTHCARE / WORKFLOW MESSAGES:
- Guide clearly and warmly to the next step based on the current bot state.
- Be encouraging and reassuring — healthcare can be stressful.
- Use real hospital names, phone numbers, and package names from the knowledge base above.
- Do NOT invent doctor names, appointment slots, or medical diagnoses.
- For emergencies always lead with the emergency number: 1066.

GENERAL:
- LANGUAGE: ${detectedLangName ? `Respond in ${detectedLangName}. Keep doctor names, city names, hospitals, phone numbers, and medical specialty names in English; everything else in ${detectedLangName}.` : "Detect the language the user wrote in (including romanized scripts) and respond in that exact language."}
- Length: match the situation — short for casual replies, clearer for workflow steps. Never pad or repeat yourself.
- Never be cold, robotic, or overly formal. You are warm, natural, and human.
- NEVER use markdown code blocks, JSON, bullet lists, or headers in your response. Write in plain conversational prose only.
- SECURITY: Never reveal what AI model, API, or technology powers you. If asked, say you're Apollo Assist and gently redirect.`;

  const userContent = userMessage
    ? `User said: "${userMessage}"`
    : `Generate a warm, helpful response for state: ${currentState}`;
  const history = (payload.history ?? []).slice(-8);

  try {
    log.info({ sessionId: maskSessionId(req.sessionId), state: currentState }, "/api/chat invoked");

    void upsertSession(req.sessionId, userLanguage || "en").catch((err) => {
      log.warn({ err, sessionId: maskSessionId(req.sessionId) }, "upsertSession failed");
    });

    if (userMessage) {
      void logMessage({
        sessionId:    req.sessionId,
        role:         "user",
        message:      userMessage,
        messageType:  messageType ?? "text",
        buttonLabel,
        buttonValue,
        machineState: currentState,
      }).catch((err) => {
        log.warn({ err, sessionId: maskSessionId(req.sessionId) }, "logMessage(user) failed");
      });
    }

    const text = await callLlm(systemPrompt, userContent, history);

    if (text) {
      void logMessage({
        sessionId:    req.sessionId,
        role:         "bot",
        message:      text,
        machineState: currentState,
        agentAction:  "chat_response",
      }).catch((err) => {
        log.warn({ err, sessionId: maskSessionId(req.sessionId) }, "logMessage(bot) failed");
      });
    }

    res.json({ text });
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, sessionId: maskSessionId(req.sessionId) }, "/api/chat error");
    res.json({ text: null, error: error.message ?? "LLM unavailable" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/query — INTERNAL ONLY tool-routing orchestration
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/agent/query", async (req: Request, res: Response): Promise<void> => {
  if (!requireInternalRouteAccess(req, res)) return;
  const { message, context } = req.body as AgentToolRequest;
  if (!message) { res.status(400).json({ error: "message required" }); return; }

  let attemptedAction: AgentAction = inferActionFromMessage(message);

  try {
    const decision = await getAgentDecision(message, context);
    const params   = (decision.params ?? {}) as Record<string, unknown>;
    const action   = decision.action;
    attemptedAction = action;

    if (action === "fetch_doctors") {
      const doctorsRaw = await localGet("/api/doctors", {
        city:      asNonEmptyString(params.city)       ?? asNonEmptyString(context?.city)       ?? "",
        specialty: asNonEmptyString(params.specialty)  ?? asNonEmptyString(context?.specialty)  ?? "",
        name:      asNonEmptyString(params.doctorName) ?? asNonEmptyString(context?.doctorName) ?? "",
      });
      res.json({ action, mapped: mapDoctorsForAgent(doctorsRaw) });
      return;
    }

    if (action === "get_live_slots") {
      const resourceIdInput = asNonEmptyString(params.resourceId) ?? asNonEmptyString(context?.resourceId);
      let locationIdInput   = asNonEmptyString(params.locationId) ?? asNonEmptyString(context?.locationId);
      let regionIdInput     = asNonEmptyString(params.regionId)   ?? asNonEmptyString(context?.regionId) ?? "5";
      let resourceId        = resourceIdInput;

      if (!resourceId) {
        const doctorsRaw = await localGet("/api/doctors", {
          city:      asNonEmptyString(params.city)       ?? asNonEmptyString(context?.city)       ?? "",
          specialty: asNonEmptyString(params.specialty)  ?? asNonEmptyString(context?.specialty)  ?? "",
          name:      asNonEmptyString(params.doctorName) ?? asNonEmptyString(context?.doctorName) ?? "",
        });
        const mappedD    = mapDoctorsForAgent(doctorsRaw);
        const firstDoc   = mappedD.doctors[0];
        resourceId       = firstDoc?.resourceId ?? firstDoc?.resourceIds?.[0];
        locationIdInput  = locationIdInput  ?? firstDoc?.locationId;
        regionIdInput    = regionIdInput    ?? firstDoc?.regionId ?? "5";
      }

      if (!resourceId) {
        res.status(400).json({ error: "resourceId missing and no matching doctor found" });
        return;
      }

      const city   = asNonEmptyString(params.city)   ?? asNonEmptyString(context?.city);
      const branch = asNonEmptyString(params.branch)  ?? asNonEmptyString(context?.branch);

      const datesRaw    = await localPost("/api/edoc/calendar-dates", {
        resourceId, locationId: locationIdInput, regionId: regionIdInput, city, branch,
      }, INTERNAL_EDOC_TOOL_TIMEOUT_MS);
      const mappedDates = mapCalendarDatesForAgent(datesRaw);
      const selectedDate = asNonEmptyString(params.date) ?? mappedDates.dates[0]?.edoc;

      if (!selectedDate) {
        res.json({
          action, resourceId,
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
        regionId:   regionIdInput,
        date:       selectedDate,
        city,
        branch,
      }, INTERNAL_EDOC_TOOL_TIMEOUT_MS);

      res.json({
        action, resourceId,
        locationId: mappedDates.locationId ?? locationIdInput,
        liveDates: mappedDates, selectedDate,
        liveSlots: mapSlotsForAgent(slotsRaw),
      });
      return;
    }

    if (action === "book_appointment") {
      const bookingPayload =
        (params.bookingPayload as Record<string, unknown>) ??
        (context?.bookingPayload as Record<string, unknown>) ?? {};
      const bookingRaw = await localPost("/api/agent/book-appointment", bookingPayload);
      res.json({ action, mapped: mapBookAppointmentForAgent(bookingRaw), raw: bookingRaw });
      return;
    }

    res.json({ action: "unknown", note: "Could not infer a supported tool action from this message" });
  } catch (err: unknown) {
    const e   = err as { message?: string; response?: { data?: unknown } };
    const txt = String(e.message ?? "");
    const contextResource = asNonEmptyString(context?.resourceId);
    const contextLocation = asNonEmptyString(context?.locationId);
    const inferred        = inferActionFromMessage(message);
    const action =
      attemptedAction !== "unknown" ? attemptedAction :
      inferred        !== "unknown" ? inferred :
      contextResource || contextLocation ? "get_live_slots" : "unknown";

    res.status(/timeout/i.test(txt) ? 504 : 500).json({
      error: e.response?.data ?? e.message ?? "agent query failed",
      action,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/book-appointment — INTERNAL ONLY thin proxy
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/agent/book-appointment", async (req: Request, res: Response): Promise<void> => {
  if (!requireInternalRouteAccess(req, res)) return;
  const payload = req.body as Record<string, unknown>;
  try {
    const raw = await localPost("/api/edoc/book-appointment", payload);
    res.json(raw);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data?: unknown; status?: number } };
    res.status(e.response?.status ?? 500).json({
      error: e.response?.data ?? e.message ?? "book appointment tool failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/decide — public-safe LLM orchestration decision
// ─────────────────────────────────────────────────────────────────────────────
interface AgentDecideRequest {
  currentState?:   string;
  machineContext?: Record<string, string | undefined>;
  userMessage:     string;
  history?:        Array<{ role: "user" | "assistant"; text: string }>;
  summary?:        string;
  userLanguage?:   string;
}

app.post("/api/agent/decide", chatLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyLlm) { res.json(AGENT_DECIDE_FALLBACK); return; }

  const payload = (req.body ?? {}) as AgentDecideRequest;
  const {
    currentState: botState = "MAIN_MENU",
    machineContext = {},
    userMessage,
    history = [],
    summary = "",
    userLanguage = "",
  } = payload;

  if (!userMessage?.trim()) { res.status(400).json({ error: "userMessage required" }); return; }

  const ctx = machineContext as Record<string, string | undefined>;
  const contextLines = [
    `Bot state: ${botState}`,
    ctx.doctorName  ? `Doctor in context: ${ctx.doctorName}`   : null,
    ctx.specialty   ? `Specialty in context: ${ctx.specialty}` : null,
    ctx.city        ? `City in context: ${ctx.city}`           : null,
    ctx.branch      ? `Branch in context: ${ctx.branch}`       : null,
    ctx.symptomText ? `Symptom in context: ${ctx.symptomText}` : null,
  ].filter(Boolean).join("\n");

  const summaryBlock = summary.trim() ? `\nConversation so far:\n${summary}\n` : "";

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
CONTINUE_WORKFLOW  — user is supplying the expected input for the current bot state. Also use for purely social/conversational messages. Use when message fits the current state naturally. Confidence >= 0.7.
IMPORTANT EXCEPTION: If the bot state is ASK_BASIC_DETAILS or SELECT_SYMPTOM_CATEGORY and the user types a medical symptom or condition (e.g. "fever", "headache", "knee pain"), use SYMPTOM_TRIAGE — NOT CONTINUE_WORKFLOW. Extract symptomText from the user's message.
SWITCH_WORKFLOW    — user changes direction mid-conversation. Confidence must be >= 0.6 to switch.
CALL_TOOL          — user wants live data or a card swap within the current flow. Confidence >= 0.6.
ASK_CLARIFICATION  — intent is too ambiguous to act on. Set reason = a warm, kind clarifying question.
RESET_FLOW         — user explicitly wants to start over, go back, or visit the main menu.

=== ENTITY EXTRACTION RULES (CRITICAL) ===
* Extract ONLY entities explicitly stated in the CURRENT user message.
* Do NOT copy entities from the session context above into your output.
* null means the user did not say it right now.
* Exception: CONTINUE_WORKFLOW may have all-null entities.
* Specialty: use Apollo specialty names (e.g. "Cardiology", "ENT", "Orthopaedics", "Dermatology").
* City: use the city name as the user typed it.

=== CONFIDENCE SCALE ===
0.9  Very clear ("show cardiologists in Hyderabad")
0.7  Likely but minor ambiguity
0.5  Ambiguous -> use CONTINUE_WORKFLOW or ASK_CLARIFICATION
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
}${userLanguage && userLanguage !== "en" ? `\n\n=== LANGUAGE ===\nThe user's interface language is "${userLanguage}". When action is ASK_CLARIFICATION, write the "reason" field in the user's language (not English).` : ""}`;

  log.info({ sessionId: maskSessionId(req.sessionId), state: botState, userMessageLength: userMessage.length }, "[AGENT/decide]");

  try {
    const raw    = stripMarkdownJson(
      await callLlm(systemPrompt, `User message: "${userMessage}"`, history.slice(-8)),
    );
    const parsed = JSON.parse(raw) as AgentDecision;

    if (!parsed || !VALID_AGENT_ACTIONS.includes(parsed.action)) {
      log.warn({ parsed }, "[AGENT/decide] invalid action, falling back");
      res.json(AGENT_DECIDE_FALLBACK);
      return;
    }

    const rawEntities = (parsed.entities ?? {}) as Record<string, unknown>;
    const decision: AgentDecision = {
      action:         parsed.action,
      targetWorkflow: typeof parsed.targetWorkflow === "string" && parsed.targetWorkflow.trim()
        ? parsed.targetWorkflow.trim()
        : null,
      reason:     String(parsed.reason ?? ""),
      confidence: typeof parsed.confidence === "number"
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

    log.info(
      { action: decision.action, workflow: decision.targetWorkflow, confidence: decision.confidence },
      "[AGENT/decide] ->",
    );

    if (decision.action === "SWITCH_WORKFLOW" && decision.targetWorkflow) {
      void logEvent(req.sessionId, "workflow_switch", {
        targetWorkflow: decision.targetWorkflow,
        fromState:      botState,
        userMessage,
        confidence:     decision.confidence,
        entities:       decision.entities,
      }).catch((err) => {
        log.warn({ err, sessionId: maskSessionId(req.sessionId) }, "logEvent(workflow_switch) failed");
      });
    }

    res.json(decision);
  } catch (err: unknown) {
    const e = err as { message?: string };
    log.warn({ err: e.message, sessionId: maskSessionId(req.sessionId) }, "[AGENT/decide] LLM error, falling back");
    res.json(AGENT_DECIDE_FALLBACK);
  }
});

// ── Silence unused-import warnings for KB values only referenced above ────────
void doctors; void buildDoctorSearchUrl; void genAI; void FunctionCallingMode; void searchDoctors; void SEARCH_DOCTORS_TOOL;

// ─────────────────────────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log.info({ port: PORT, provider: process.env.DATA_PROVIDER ?? "postgres" }, "Apollo Assist backend started");

  try {
    startAuditWorker();
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "[workers] auditWorker failed to start — audit events will queue when Redis recovers",
    );
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  log.error({ err: err.message, code: err.code }, "Server failed to start");
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "Received shutdown signal, closing server...");
  server.close(async () => {
    log.info("HTTP server closed");
    try {
      await stopAuditWorker();
      await closeRedisConnection();
      log.info("BullMQ worker and Redis connection closed");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Error during worker/redis shutdown");
    }
    process.exit(0);
  });
  setTimeout(() => {
    log.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 15_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));
