/**
 * useChatMachine.ts
 * React hook that wraps the XState ApolloAssistRunner.
 * Exposes messages, currentState, and action functions to the UI.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ApolloAssistRunner } from "../../apolloAssistMachine";
import { mapInputToEvent, AppEvent } from "../inputMapping.js";
import { getStateResponse, ChatContext, QuickReply } from "../stateResponses";
import { maskSensitiveData } from "../maskSensitiveData";

export interface ChatMessage {
  id: number;
  sender: "bot" | "user";
  text: string;
}

export interface DoctorCardData {
  name: string;
  specialty?: string;
  hospital: string;
  profileUrl?: string;
  resourceId?: string;    // EDOC ResourceID
  resourceIds?: string[]; // Alternate EDOC ResourceIDs for same doctor-name mapping
  locationId?: string;    // EDOC LocationID
  regionId?: string;      // EDOC RegionID
  serviceId?: string;     // EDOC ServiceID
}

/**
 * Structured decision returned by POST /api/agent/decide.
 * The LLM proposes; XState + tools execute.
 */
export interface AgentDecision {
  action: "CONTINUE_WORKFLOW" | "SWITCH_WORKFLOW" | "CALL_TOOL" | "ASK_CLARIFICATION" | "RESET_FLOW";
  targetWorkflow: string | null;
  reason: string;
  confidence: number;
  entities: {
    doctorName: string | null;
    specialty: string | null;
    city: string | null;
    branch: string | null;
    symptomText: string | null;
  };
}

/** One live date entry returned by /api/edoc/calendar-dates */
export interface LiveDate {
  display: string;   // "1/7/2025"
  edoc: string;      // "01-JUL-2025"
  label: string;     // "MON"
  date: string;      // "1"
  month: string;     // "JUL"
}

interface AvailableDatesResponse {
  dates?: Array<{ display: string; edoc: string }>;
  retcode?: number;
  error?: string;
  locationId?: string;
}

interface SlotsResponse {
  slots?: string[];
  retcode?: number;
  error?: string;
  locationId?: string;
}

interface SlotsV2Response {
  services?: Array<{
    serviceId: string;
    requestDate?: string;
    startTime?: string;
    endTime?: string;
    slotInterval?: string;
    maxSlot?: string;
    slots: string[];
  }>;
  allSlots?: string[];
  slotToServiceId?: Record<string, string>;
  defaultServiceId?: string | null;
  retcode?: number;
  error?: string;
  locationId?: string;
  message?: string | null;
}

interface CalendarDetailsResponse {
  calendar?: Array<Record<string, unknown>>;
  retcode?: number;
  error?: string;
  locationId?: string;
  message?: string | null;
}

interface BookAppointmentResponse {
  AppointmentID?: string | number;
  retcode?: number;
  Message?: string | null;
  error?: unknown;
}

let msgId = 0;
const nextId = () => ++msgId;

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const DAYS   = ["SUN","MON","TUE","WED","THU","FRI","SAT"];

/**
 * Heuristic: detect language from Unicode script ranges (instant, no API call).
 * Returns an ISO 639-1 code when a non-Latin script is detected, otherwise null.
 */
function detectScriptLanguage(text: string): string | null {
  if (/[\u0C00-\u0C7F]/.test(text)) return "te"; // Telugu
  if (/[\u0900-\u097F]/.test(text)) return "hi"; // Devanagari (Hindi/Marathi)
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta"; // Tamil
  if (/[\u0C80-\u0CFF]/.test(text)) return "kn"; // Kannada
  if (/[\u0D00-\u0D7F]/.test(text)) return "ml"; // Malayalam
  if (/[\u0A80-\u0AFF]/.test(text)) return "gu"; // Gujarati
  if (/[\u0980-\u09FF]/.test(text)) return "bn"; // Bengali
  if (/[\u0A00-\u0A7F]/.test(text)) return "pa"; // Gurmukhi (Punjabi)
  if (/[\u0600-\u06FF]/.test(text)) return "ur"; // Arabic/Urdu
  return null;
}

// States where Gemini adds no value — use static responses directly.
// Includes: transient auto-transitions, loading spinners, error dead-ends, and
// states whose UI is driven entirely by machine context (doctor cards, confirm page).
const NO_LLM_STATES = new Set([
  "PROCESS_UHID", "PROCESS_BOOKING", "PROCESS_RESCHEDULE", "PROCESS_CANCEL",
  "GENERATE_UHID_STATE", "PROCESS_DOCTOR_NAME", "PROCESS_SPECIALTY",
  "SEARCH_DOCTORS_BY_CRITERIA", "DOCTORS_FOUND", "DOCTOR_FOUND", "SPECIALTY_FOUND",
  "ASK_CITY", "ASK_CITY_FOR_LOCATION", "ASK_BRANCH", "ASK_BRANCH_FOR_LOCATION",
  "DOCTOR_NOT_FOUND_ASK_CITY",  // static city picker + fuzzy search on city selection
  "SEARCH_BY_SPECIALTY_STATE", "PROCESS_SYMPTOM_CATEGORY", "PROCESS_SYMPTOM_DETAIL",
  "MAP_TO_SPECIALTY", "BOOKING_FAILED_STATE", "RESCHEDULE_FAILED_STATE",
  "CANCEL_FAILED_STATE", "UHID_GENERATE_FAILED",
  "DOCTOR_NAME_SUGGESTIONS", // rendered by stateResponses with suggestion buttons
  "AI_PREFILL_ROUTE",        // transient routing state, never shown
  "SHOW_DOCTORS",            // UI is card-driven; LLM message shown before cards load
  "CONFIRM_APPOINTMENT",     // Dynamic context-aware message handled by stateResponses
  "BOOKING_CONFIRMED",       // Dynamic message handled by stateResponses
  "CHECK_EXISTING_APPOINTMENT", // Transient: fires API check then auto-transitions
  "EXISTING_APPT_WARNING",   // Static warning message + buttons
]);

// States where free-text should first be sent to the AI intent parser (legacy fallback).
const AI_NAV_STATES = [
  "WELCOME", "MAIN_MENU", "FALLBACK",
  "BOOK_APPT_OPTIONS", "BOOK_APPT_OPTIONS_LOCATION",
  "FIND_DOCTOR_OPTIONS",
];

// XState states that accept the AI_PREFILL event directly.
// Used by executeAgentDecision to know whether a BACK_TO_MENU hop is needed first.
const AI_PREFILL_STATES = new Set([
  "WELCOME", "MAIN_MENU", "BOOK_APPT_OPTIONS", "BOOK_APPT_OPTIONS_LOCATION",
  "FIND_DOCTOR_OPTIONS", "FALLBACK",
]);

// States where the agent-decide pipeline runs on every free-text turn.
// Wider than AI_NAV_STATES — covers mid-workflow redirects (e.g. from ENTER_DOCTOR_NAME).
const AGENT_DECIDE_STATES = new Set([
  // Navigation / menu
  "WELCOME", "MAIN_MENU", "FALLBACK",
  // Booking entry
  "BOOK_APPT_OPTIONS", "BOOK_APPT_OPTIONS_LOCATION", "FIND_DOCTOR_OPTIONS",
  // Mid-workflow — user might redirect here
  "ENTER_DOCTOR_NAME", "SELECT_SPECIALTY", "ASK_BASIC_DETAILS",
  "ASK_CITY", "ASK_CITY_FOR_LOCATION", "ASK_BRANCH", "ASK_BRANCH_FOR_LOCATION",
  "DOCTOR_NAME_SUGGESTIONS", "DOCTOR_NOT_FOUND_ASK_CITY",
  "HEALTH_CHECKUP_ENTRY",
  // Symptom flow — user may type a symptom instead of pressing a button
  "SELECT_SYMPTOM_CATEGORY",
  // Results / post-booking
  "SHOW_DOCTORS", "BOOKING_CONFIRMED",
  // Error / not-found recovery
  "DOCTOR_NOT_FOUND", "SPECIALTY_NOT_FOUND", "BOOKING_FAILED_STATE",
]);

function parseLiveDate(dateStr: string): LiveDate {
  const [d, m, y] = dateStr.split("/");
  const dt = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  return {
    display: dateStr,
    edoc: `${d.padStart(2, "0")}-${MONTHS[parseInt(m) - 1]}-${y}`,
    label: DAYS[dt.getDay()],
    date: d,
    month: MONTHS[parseInt(m) - 1],
  };
}

/** Add 15 minutes to "HH:MM" → "HH:MM" */
function addFifteenMin(time: string): string {
  const [h, mi] = time.split(":").map(Number);
  const total = h * 60 + mi + 15;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function isValidLocationId(locationId?: string): boolean {
  return /^\d+$/.test(String(locationId ?? "").trim());
}

function getSafeLocationId(locationId?: string, fallback = "10551"): string {
  return isValidLocationId(locationId) ? String(locationId).trim() : fallback;
}

/**
 * Builds a short rolling summary string for a given key event.
 * The summary is injected into /api/chat so the LLM has factual "long-term memory"
 * without needing the full message history. Max ~300 tokens.
 */
type SummaryEvent =
  | { type: "doctors_shown"; specialty?: string; city?: string; branch?: string; doctorName?: string }
  | { type: "doctor_selected"; doctorName: string; specialty?: string; city?: string; branch?: string; date?: string; time?: string }
  | { type: "booking_done"; doctorName?: string; specialty?: string; city?: string; branch?: string; date?: string; time?: string; appointmentId?: string }
  | { type: "booking_requested"; doctorName?: string; specialty?: string; city?: string; branch?: string };

function buildSummary(prev: string, event: SummaryEvent): string {
  const lines = prev ? prev.split("\n").filter(Boolean) : [];

  switch (event.type) {
    case "doctors_shown": {
      const where = [event.branch, event.city].filter(Boolean).join(", ");
      const subject = event.doctorName
        ? `doctor "${event.doctorName}"`
        : event.specialty ?? "doctors";
      const line = `Searched for ${subject}${where ? ` in ${where}` : ""}.`;
      // Replace any prior search line so we don't accumulate repeated searches
      const filtered = lines.filter((l) => !l.startsWith("Searched "));
      return [...filtered, line].slice(-6).join("\n");
    }
    case "doctor_selected": {
      const where = [event.branch, event.city].filter(Boolean).join(", ");
      const when = event.date ? ` on ${event.date}${event.time ? ` at ${event.time}` : ""}` : "";
      const line = `• Selected ${event.doctorName}${event.specialty ? ` (${event.specialty})` : ""}${where ? ` at ${where}` : ""}${when}.`;
      const filtered = lines.filter((l) => !l.startsWith("• Selected "));
      return [...filtered, line].slice(-8).join("\n");
    }
    case "booking_done": {
      const where = [event.branch, event.city].filter(Boolean).join(", ");
      const when = event.date ? ` on ${event.date}${event.time ? ` at ${event.time}` : ""}` : "";
      const appt = event.appointmentId && event.appointmentId !== "REQUEST" ? ` (Appt ID: ${event.appointmentId})` : "";
      const line = `• Booking confirmed: ${event.doctorName ?? "doctor"}${event.specialty ? ` (${event.specialty})` : ""}${where ? ` at ${where}` : ""}${when}${appt}.`;
      const filtered = lines.filter((l) => !l.startsWith("• Booking ") && !l.startsWith("• Appointment requested"));
      return [...filtered, line].slice(-8).join("\n");
    }
    case "booking_requested": {
      const where = [event.branch, event.city].filter(Boolean).join(", ");
      const line = `• Appointment requested: ${event.doctorName ?? "a doctor"}${event.specialty ? ` (${event.specialty})` : ""}${where ? ` at ${where}` : ""}.`;
      const filtered = lines.filter((l) => !l.startsWith("• Appointment requested") && !l.startsWith("• Booking "));
      return [...filtered, line].slice(-8).join("\n");
    }
  }
}


/** Retrieve or create a persistent session ID stored in localStorage. */
function getOrCreateSessionId(): string {
  const KEY = "apollo_session_id";
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(KEY, id);
  return id;
}

export function useChatMachine() {
  // Stable session identifier — created once per browser and sent as X-Session-Id header
  const sessionIdRef = useRef<string>(getOrCreateSessionId());

  const runnerRef = useRef<ApolloAssistRunner | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Keep ref in sync with state so callbacks can read current messages without dep issues
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [currentState, setCurrentState] = useState<string>("WELCOME");
  const [machineCtx, setMachineCtx] = useState<ChatContext>({});

  // Persist machine state so doctor cards and context survive page refresh
  useEffect(() => {
    if (currentState !== "WELCOME") {
      localStorage.setItem("apollo_machine_snapshot", JSON.stringify({ state: currentState, ctx: machineCtx }));
    }
  }, [currentState, machineCtx]);
  const [isLlmLoading, setIsLlmLoading] = useState(false);
  const [rateLimitSeconds, setRateLimitSeconds] = useState<number>(0);
  const [doctorCards, setDoctorCards] = useState<DoctorCardData[]>([]);
  // ID of the bot message after which doctor cards should be rendered inline
  const [cardsAnchorMsgId, setCardsAnchorMsgId] = useState<number | null>(null);
  // Rolling conversation summary — injected into /api/chat as "long-term memory"
  const [conversationSummary, setConversationSummary] = useState<string>("");
  const conversationSummaryRef = useRef<string>("");
  useEffect(() => { conversationSummaryRef.current = conversationSummary; }, [conversationSummary]);

  // ── Multilingual support ────────────────────────────────────────────────
  /** ISO 639-1 code of the user's detected language (e.g. "te", "hi"). Default "en". */
  const [userLanguage, setUserLanguage] = useState<string>("en");
  /** Ref keeps the current language accessible inside synchronous callbacks without deps. */
  const userLanguageRef = useRef<string>("en");
  /** Translated quick-reply chips for the current state (null = show English originals). */
  const [translatedQuickReplies, setTranslatedQuickReplies] = useState<QuickReply[] | null>(null);
  /** Cache: `"<lang>:<labels joined>"` → translated labels array. Persists across renders. */
  const quickReplyLabelCache = useRef<Map<string, string[]>>(new Map());
  /** Cache: `"<lang>:<original message>"` → translated message. Avoids re-calling API. */
  const uiTranslationCache = useRef<Map<string, string>>(new Map());
  /** Tracks in-flight translate-ui requests so we don't fire duplicates simultaneously. */
  const translationInFlight = useRef<Set<string>>(new Set());

  // Clear summary whenever the user returns to the main menu (Back to Menu, any reset)
  const prevStateRef = useRef<string>("WELCOME");
  useEffect(() => {
    if (
      currentState === "MAIN_MENU" &&
      prevStateRef.current !== "MAIN_MENU" &&
      prevStateRef.current !== "WELCOME"
    ) {
      setConversationSummary("");
    }
    prevStateRef.current = currentState;
  }, [currentState]);

  // ── Translate quick reply chips when state or language changes ──────────
  useEffect(() => {
    if (!userLanguage || userLanguage === "en") {
      setTranslatedQuickReplies(null);
      return;
    }
    const resp = getStateResponse(currentState, machineCtx);
    const labels = resp.quickReplies.map((q) => q.label);
    if (labels.length === 0) {
      setTranslatedQuickReplies(null);
      return;
    }
    const cacheKey = `${userLanguage}:${labels.join("\x00")}`;
    const cached = quickReplyLabelCache.current.get(cacheKey);
    if (cached) {
      setTranslatedQuickReplies(resp.quickReplies.map((q, i) => ({ ...q, label: cached[i] ?? q.label })));
      return;
    }
    // Prevent concurrent identical requests
    if (translationInFlight.current.has(cacheKey)) return;
    translationInFlight.current.add(cacheKey);

    void (async () => {
      try {
        const res = await fetch("/api/translate-ui", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strings: labels, targetLanguage: userLanguage }),
        });
        if (!res.ok) return;
        const data = await res.json() as { translations?: string[] };
        const translations = data.translations ?? labels;
        quickReplyLabelCache.current.set(cacheKey, translations);
        // Only update if state/language haven't changed while we were fetching
        setTranslatedQuickReplies((prev) => {
          // If machine moved on, the effect will re-run and will pick the right cache entry
          void prev;
          return resp.quickReplies.map((q, i) => ({ ...q, label: translations[i] ?? q.label }));
        });
      } catch {
        // Keep English on failure — don't set translatedQuickReplies
      } finally {
        translationInFlight.current.delete(cacheKey);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, userLanguage, machineCtx.city, machineCtx.branch, machineCtx.specialty, machineCtx.doctorName, machineCtx.doctorSuggestions]);

  // Mirror of messages for use inside callbacks without adding to deps arrays
  const messagesRef = useRef<ChatMessage[]>([]);

  // Live dates: key = doctorKey, value = LiveDate[]
  const [liveDates, setLiveDates] = useState<Record<string, LiveDate[]>>({});
  // Live slots: key = `${doctorKey}||${edocDate}`, value = string[] (times like "08:00")
  const [liveSlots, setLiveSlots] = useState<Record<string, string[]>>({});
  // Key = `${doctorKey}||${edocDate}||${slot}`; value = serviceId from DoctorCalenderRules_V2
  const [slotServiceByKey, setSlotServiceByKey] = useState<Record<string, string>>({});
  const [slotsLoading, setSlotsLoading] = useState<Record<string, boolean>>({});
  const liveDateRequestsInFlight = useRef<Set<string>>(new Set());
  const liveDateRequestsDone = useRef<Set<string>>(new Set());
  const liveScheduleListKey = useRef<string>("");
  const noLiveDatesNoticeKey = useRef<string>("");
  const similarNameNoticeKey = useRef<string>("");

  // Initialize runner once; attempt session hydration before showing welcome
  useEffect(() => {
    const runner = new ApolloAssistRunner();
    runnerRef.current = runner;
    const initial = runner.currentState;
    setCurrentState(initial);

    const showWelcome = () => {
      const welcome = getStateResponse(initial);
      setMessages([{ id: nextId(), sender: "bot", text: welcome.message }]);
    };

    const fetchSession = async (retries = 3, delayMs = 1500): Promise<void> => {
      const sid = sessionIdRef.current;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const r = await fetch(`/api/session/${encodeURIComponent(sid)}`, {
            headers: { "X-Session-Id": sid },
          });
          if (r.ok) {
            const data = await r.json() as { messages?: Array<{ role: string; message: string }> };
            const msgs = data?.messages ?? [];
            if (msgs.length > 0) {
              setMessages(
                msgs.map((m) => ({
                  id:     nextId(),
                  sender: (m.role === "user" ? "user" : "bot") as "user" | "bot",
                  text:   m.message,
                }))
              );
              // Restore machine state (currentState + machineCtx) so doctor cards re-render
              const snapshotRaw = localStorage.getItem("apollo_machine_snapshot");
              if (snapshotRaw) {
                try {
                  const snap = JSON.parse(snapshotRaw) as { state: string; ctx: ChatContext };
                  if (snap.state && snap.ctx) {
                    setCurrentState(snap.state);
                    setMachineCtx(snap.ctx);
                  }
                } catch { /* ignore corrupt snapshot */ }
              }
            } else {
              showWelcome();
            }
            return;
          }
          if (r.status === 404) {
            // Brand-new session — no retry needed
            showWelcome();
            return;
          }
        } catch {
          // Network error (ECONNREFUSED during startup race) — retry after delay
        }
        if (attempt < retries - 1) {
          await new Promise<void>((res) => setTimeout(res, delayMs));
        }
      }
      showWelcome();
    };

    void fetchSession();

    return () => runner.stop();
  }, []);

  // Static response
  const pushStaticBotMessage = useCallback((state: string, ctx: ChatContext) => {
    const resp = getStateResponse(state, ctx);
    const msgId = nextId();
    setMessages((prev) => [...prev, { id: msgId, sender: "bot", text: resp.message }]);

    // Persist bot message so session restore shows it on page refresh.
    // Inline fetch (not logInteraction) to avoid a circular useCallback dependency.
    void fetch("/api/log-interaction", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionIdRef.current },
      body: JSON.stringify({ message: resp.message, messageType: "system_event", machineState: state, role: "bot" }),
    }).catch((err) => {
      console.warn("[CHAT] Failed to persist static bot message:", err);
    });

    // Background-translate the static message when the UI language is non-English.
    // The English text is shown immediately; we replace it once the translation arrives.
    const lang = userLanguageRef.current;
    if (!lang || lang === "en") return;

    void (async () => {
      const cacheKey = `${lang}:${resp.message}`;
      try {
        let translated: string | undefined = uiTranslationCache.current.get(cacheKey);
        if (!translated) {
          const res = await fetch("/api/translate-ui", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ strings: [resp.message], targetLanguage: lang }),
          });
          if (!res.ok) return;
          const data = await res.json() as { translations?: string[] };
          translated = data.translations?.[0];
          if (translated) uiTranslationCache.current.set(cacheKey, translated);
        }
        if (translated && translated !== resp.message) {
          setMessages((prev) =>
            prev.map((m) => m.id === msgId ? { ...m, text: translated! } : m)
          );
        }
      } catch { /* keep English on failure */ }
    })();
  }, []); // userLanguageRef and uiTranslationCache are refs — no deps needed

  /**
   * Detects the user's language from their message and updates userLanguageRef + userLanguage.
   * Uses instant Unicode-script heuristic first; falls back to LLM for romanized scripts.
   * Fire-and-forget — never throws.
   */
  const detectAndSetLanguage = useCallback(async (text: string): Promise<void> => {
    // 1. Instant script detection (no API call)
    const scriptLang = detectScriptLanguage(text);
    if (scriptLang) {
      if (scriptLang !== userLanguageRef.current) {
        userLanguageRef.current = scriptLang;
        setUserLanguage(scriptLang);
      }
      return;
    }
    // 2. Skip very short / purely numeric input — not enough signal
    const trimmed = text.trim();
    if (trimmed.length < 4 || /^\d+$/.test(trimmed)) return;

    // 3. LLM-based detection for romanized text (async, fire-and-forget)
    try {
      const res = await fetch("/api/detect-language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed.slice(0, 200) }),
      });
      if (!res.ok) return;
      const data = await res.json() as { code?: string };
      const code = String(data.code ?? "en").toLowerCase().trim();
      if (code && code !== userLanguageRef.current) {
        userLanguageRef.current = code;
        setUserLanguage(code);
      }
    } catch { /* keep current language */ }
  }, []);

  const logEdoc = useCallback((step: string, payload: Record<string, unknown>) => {
    const summary = {
      keys: Object.keys(payload).slice(0, 12),
      keyCount: Object.keys(payload).length,
      status: payload.status,
      retcode: payload.retcode,
      error: payload.error ? String(payload.error).slice(0, 120) : undefined,
    };
    console.info(`[EDOC] ${step}`, maskSensitiveData(summary));
  }, []);

  const getAvailableDates = useCallback(async (
    params: {
      resourceId: string;
      locationId: string;
      regionId: string;
      city?: string;
      signal?: AbortSignal;
    }
  ): Promise<AvailableDatesResponse> => {
    logEdoc("DoctorCalenderLiveDates.request", {
      resourceId: params.resourceId,
      locationId: params.locationId,
      regionId: params.regionId,
      city: params.city ?? null,
    });
    const res = await fetch("/api/edoc/calendar-dates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: params.resourceId,
        locationId: params.locationId,
        regionId: params.regionId,
        city: params.city,
      }),
      signal: params.signal,
    });
    const data = (await res.json()) as AvailableDatesResponse;
    const datesCount = (data.dates ?? []).length;
    logEdoc("DoctorCalenderLiveDates.response", { status: res.status, data });
    logEdoc("DoctorCalenderLiveDates.summary", {
      resourceId: params.resourceId,
      locationId: data.locationId ?? params.locationId,
      retcode: data.retcode ?? null,
      datesCount,
      error: data.error ?? null,
    });
    if (datesCount === 0) {
      logEdoc("DoctorCalenderLiveDates.no_live_dates", {
        resourceId: params.resourceId,
        requestedLocationId: params.locationId,
        resolvedLocationId: data.locationId ?? params.locationId,
        regionId: params.regionId,
        city: params.city ?? null,
        retcode: data.retcode ?? null,
        error: data.error ?? null,
        reason: data.error ? "calendar-dates returned an error" : "calendar-dates returned an empty dates array",
      });
    }
    if (!res.ok) {
      throw new Error(String(data.error ?? "DoctorCalenderLiveDates failed"));
    }
    return data;
  }, [logEdoc]);

  const getSlots = useCallback(async (
    params: {
      resourceId: string;
      locationId: string;
      regionId: string;
      date: string;
      city?: string;
      signal?: AbortSignal;
    }
  ): Promise<SlotsResponse> => {
    logEdoc("DoctorCalenderRules.request", params as unknown as Record<string, unknown>);
    const res = await fetch("/api/edoc/slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: params.resourceId,
        locationId: params.locationId,
        regionId: params.regionId,
        date: params.date,
        city: params.city,
      }),
      signal: params.signal,
    });
    const data = (await res.json()) as SlotsResponse;
    logEdoc("DoctorCalenderRules.response", { status: res.status, data });
    logEdoc("DoctorCalenderRules.summary", {
      resourceId: params.resourceId,
      locationId: data.locationId ?? params.locationId,
      date: params.date,
      retcode: data.retcode ?? null,
      slotsCount: (data.slots ?? []).length,
      error: data.error ?? null,
    });
    if (!res.ok) {
      throw new Error(String(data.error ?? "DoctorCalenderRules failed"));
    }
    return data;
  }, [logEdoc]);

  const getSlotsV2 = useCallback(async (
    params: {
      resourceId: string;
      locationId: string;
      regionId: string;
      date: string;
      city?: string;
      signal?: AbortSignal;
    }
  ): Promise<SlotsV2Response> => {
    logEdoc("DoctorCalenderRules_V2.request", params as unknown as Record<string, unknown>);
    const res = await fetch("/api/edoc/slots-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: params.resourceId,
        locationId: params.locationId,
        regionId: params.regionId,
        date: params.date,
        city: params.city,
      }),
      signal: params.signal,
    });
    const data = (await res.json()) as SlotsV2Response;
    logEdoc("DoctorCalenderRules_V2.response", { status: res.status, data });
    logEdoc("DoctorCalenderRules_V2.summary", {
      resourceId: params.resourceId,
      locationId: data.locationId ?? params.locationId,
      date: params.date,
      retcode: data.retcode ?? null,
      servicesCount: (data.services ?? []).length,
      slotsCount: (data.allSlots ?? []).length,
      defaultServiceId: data.defaultServiceId ?? null,
      error: data.error ?? null,
    });
    if (!res.ok) {
      throw new Error(String(data.error ?? "DoctorCalenderRules_V2 failed"));
    }
    return data;
  }, [logEdoc]);

  const getCalendarDetails = useCallback(async (
    params: {
      resourceId: string;
      locationId: string;
      regionId: string;
      date: string;
      city?: string;
      signal?: AbortSignal;
    }
  ): Promise<CalendarDetailsResponse> => {
    logEdoc("GetCalendardetailsforOnline.request", params as unknown as Record<string, unknown>);
    const res = await fetch("/api/edoc/calendar-details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: params.resourceId,
        locationId: params.locationId,
        regionId: params.regionId,
        date: params.date,
        city: params.city,
      }),
      signal: params.signal,
    });
    const data = (await res.json()) as CalendarDetailsResponse;
    logEdoc("GetCalendardetailsforOnline.response", { status: res.status, data });
    logEdoc("GetCalendardetailsforOnline.summary", {
      resourceId: params.resourceId,
      locationId: data.locationId ?? params.locationId,
      date: params.date,
      retcode: data.retcode ?? null,
      calendarRows: (data.calendar ?? []).length,
      error: data.error ?? null,
    });
    if (!res.ok) {
      throw new Error(String(data.error ?? "GetCalendardetailsforOnline failed"));
    }
    return data;
  }, [logEdoc]);

  const formatSlot = useCallback((edocDate: string, selectedSlot: string): { StartDateTime: string; EndDateTime: string } => {
    if (!/^\d{2}-[A-Z]{3}-\d{4}$/.test(edocDate)) {
      throw new Error(`Invalid EDOC date format: ${edocDate}`);
    }
    if (!/^\d{2}:\d{2}$/.test(selectedSlot)) {
      throw new Error(`Invalid slot format: ${selectedSlot}`);
    }
    const StartDateTime = `${edocDate} ${selectedSlot}:00`;
    const EndDateTime = `${edocDate} ${addFifteenMin(selectedSlot)}:00`;
    return { StartDateTime, EndDateTime };
  }, []);

  const bookAppointment = useCallback(async (payload: Record<string, unknown>): Promise<BookAppointmentResponse> => {
    // Generate a stable idempotency key for this booking attempt.
    // If the user double-clicks or the frontend retries, the same UUID
    // is NOT re-used — each *new* user-initiated booking gets a fresh key.
    // The key is generated here (just before the call) so retries within
    // the same useCallback invocation share it, but a second button press
    // creates a brand-new invocation with a new UUID.
    const bookingRequestId = crypto.randomUUID();
    const payloadWithKey = { ...payload, bookingRequestId };

    logEdoc("BookAppointment.request", payloadWithKey);
    const res = await fetch("/api/edoc/book-appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWithKey),
    });
    const data = (await res.json()) as BookAppointmentResponse;
    logEdoc("BookAppointment.response", { status: res.status, data });
    if (!res.ok) {
      throw new Error(String((data as { error?: string }).error ?? "BookAppointment failed"));
    }
    return data;
  }, [logEdoc]);

  // Fire event silently (no bot message — used for async EDOC transitions)
  const sendSilentEvent = useCallback((eventType: string, value?: string) => {
    const runner = runnerRef.current;
    if (!runner) return;
    const event = (value !== undefined
      ? { type: eventType, value }
      : { type: eventType }) as AppEvent;
    runner.sendEvent(event);
    const nextState = runner.currentState;
    const nextCtx = runner.context as ChatContext;
    // Reset EDOC fire guard when moving to a new state
    if (nextState !== edocFiredForState.current) {
      edocFiredForState.current = "";
    }
    setCurrentState(nextState);
    setMachineCtx(nextCtx);
    // Push a bot message for the new state
    pushStaticBotMessage(nextState, nextCtx);
  }, [pushStaticBotMessage]);

  // ── LLM-generated rolling summary ─────────────────────────────────────────
  // Fire-and-forget: takes the last 16 messages and asks the LLM for a short
  // bullet-point summary. Called after doctor cards load and after booking completes.
  const updateSummaryWithLlm = useCallback(async () => {
    const recent = messagesRef.current
      .filter((m) => m.text.trim().length > 0)
      .slice(-16)
      .map((m) => ({ role: (m.sender === "user" ? "user" : "assistant") as "user" | "assistant", text: m.text }));
    if (recent.length < 2) return;
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: recent }),
      });
      if (res.ok) {
        const data = await res.json() as { summary?: string };
        if (data.summary) setConversationSummary(data.summary);
      }
    } catch { /* keep existing summary on failure */ }
  }, []);

  // ── Load doctor cards when entering SHOW_DOCTORS ─────────────────────────
  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS" && currentState !== "RESCHEDULE_APPOINTMENT") {
      if (currentState !== "SHOW_DOCTORS") {
        setDoctorCards([]);
        setCardsAnchorMsgId(null);
        similarNameNoticeKey.current = "";
      }
      return;
    }
    if (currentState === "RESCHEDULE_APPOINTMENT") {
      // Show only the originally booked doctor's card (from context)
      const hospital = machineCtx.branch
        ? `${machineCtx.branch}${machineCtx.city ? `, ${machineCtx.city}` : ""}`
        : machineCtx.city
        ? `Apollo Hospitals, ${machineCtx.city}`
        : "Apollo Hospitals";
      const anchorId = messagesRef.current[messagesRef.current.length - 1]?.id ?? null;
      setDoctorCards([{
        name:       machineCtx.doctorName ?? "Your Doctor",
        specialty:  machineCtx.specialty,
        hospital,
        resourceId: machineCtx.resourceId,
        locationId: machineCtx.locationId,
        regionId:   machineCtx.regionId ?? "5",
        serviceId:  machineCtx.serviceId,
      }]);
      setCardsAnchorMsgId(anchorId);
      return;
    }

    const hospital = machineCtx.branch
      ? `${machineCtx.branch}${machineCtx.city ? `, ${machineCtx.city}` : ""}`
      : machineCtx.city
      ? `Apollo Hospitals, ${machineCtx.city}`
      : "Selected Apollo location";

    const fallbackName = machineCtx.doctorName ?? (machineCtx.specialty ? `${machineCtx.specialty} specialist` : "Apollo doctor");
    const controller = new AbortController();

    const loadDoctors = async () => {
      try {
        const params = new URLSearchParams();
        if (machineCtx.specialty)  params.set("specialty", machineCtx.specialty);
        if (machineCtx.city)       params.set("city",      machineCtx.city);
        if (machineCtx.branch)     params.set("branch",    machineCtx.branch);
        if (machineCtx.doctorName) params.set("name",      machineCtx.doctorName);

        const res = await fetch(`/api/doctors?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error("doctor fetch failed");
        const data = (await res.json()) as {
          nameFallback?: {
            requestedName?: string;
          } | null;
          doctors?: Array<{
            name: string;
            specialty?: string;
            hospital?: string;
            profileUrl?: string;
            resourceId?: string;
            resourceIds?: string[];
            locationId?: string;
            regionId?: string;
            serviceId?: string;
          }>;
        };

        const cards = (data.doctors ?? []).map((d) => ({
          name:       d.name,
          specialty:  d.specialty ?? machineCtx.specialty,
          hospital:   d.hospital  ?? hospital,
          profileUrl: d.profileUrl,
          resourceId: d.resourceId,
          resourceIds: d.resourceIds,
          locationId: d.locationId,
          regionId:   d.regionId ?? "5",
          serviceId:  d.serviceId,
        }));

        let anchorId = messagesRef.current[messagesRef.current.length - 1]?.id ?? null;
        const requestedName = String(data.nameFallback?.requestedName ?? "").trim();
        if (requestedName && cards.length > 0) {
          const noticeKey = `${requestedName.toLowerCase()}|${String(machineCtx.city ?? "").toLowerCase()}|${String(machineCtx.branch ?? "").toLowerCase()}|${String(machineCtx.specialty ?? "").toLowerCase()}`;
          if (similarNameNoticeKey.current !== noticeKey) {
            similarNameNoticeKey.current = noticeKey;
            const noticeId = nextId();
            setMessages((prev) => [
              ...prev,
              {
                id: noticeId,
                sender: "bot",
                text: `Did not find doctors with the name \"${requestedName}\". Showing available doctors with similar name:`,
              },
            ]);
            anchorId = noticeId;
          }
        }
        if (cards.length > 0) {
          setDoctorCards(cards);
          setCardsAnchorMsgId(anchorId);
        } else if (
          (machineCtx.specialty ?? "").toLowerCase() === "general physician" &&
          !machineCtx.doctorName
        ) {
          // Fallback: try "General Medicine" when "General Physician" returns no results
          const fallbackParams = new URLSearchParams();
          fallbackParams.set("specialty", "General Medicine");
          if (machineCtx.city)   fallbackParams.set("city",   machineCtx.city);
          if (machineCtx.branch) fallbackParams.set("branch", machineCtx.branch);
          const fallbackRes = await fetch(`/api/doctors?${fallbackParams.toString()}`, { signal: controller.signal });
          const fallbackData = fallbackRes.ok
            ? (await fallbackRes.json()) as { doctors?: typeof data.doctors }
            : { doctors: [] };
          const fallbackCards = (fallbackData.doctors ?? []).map((d) => ({
            name:        d.name,
            specialty:   d.specialty ?? "General Medicine",
            hospital:    d.hospital  ?? hospital,
            profileUrl:  d.profileUrl,
            resourceId:  d.resourceId,
            resourceIds: d.resourceIds,
            locationId:  d.locationId,
            regionId:    d.regionId ?? "5",
            serviceId:   d.serviceId,
          }));
          if (fallbackCards.length > 0) {
            setDoctorCards(fallbackCards);
            setCardsAnchorMsgId(anchorId);
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === anchorId
                  ? { ...m, text: "No doctors were found matching your search criteria. Please try a different specialty, branch, or city." }
                  : m
              )
            );
            setDoctorCards([]);
            setCardsAnchorMsgId(null);
          }
        } else {
          // No doctors found — replace the "Showing available doctors..." message with the no-doctors message, show no cards
          setMessages((prev) =>
            prev.map((m) =>
              m.id === anchorId
                ? { ...m, text: "No doctors were found matching your search criteria. Please try a different specialty, branch, or city." }
                : m
            )
          );
          setDoctorCards([]);
          setCardsAnchorMsgId(null);
        }
        // Update rolling summary with LLM after cards are shown
        void updateSummaryWithLlm();
      } catch {
        const anchorId = messagesRef.current[messagesRef.current.length - 1]?.id ?? null;
        setDoctorCards([{ name: fallbackName, specialty: machineCtx.specialty, hospital }]);
        setCardsAnchorMsgId(anchorId);
      }
    };

    void loadDoctors();
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx.branch, machineCtx.city, machineCtx.doctorName, machineCtx.specialty]);

  // ── Load live dates for each doctor card that has a resourceId ───────────
  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS" && currentState !== "RESCHEDULE_APPOINTMENT") return;
    if (doctorCards.length === 0) return;

    const scheduleCards = doctorCards
      .map((doctor, idx) => ({ doctor, idx }))
      .filter(({ doctor }) => !!doctor.locationId)
      .map(({ doctor, idx }) => {
        const stableCandidates = Array.from(new Set(
          [doctor.resourceId, ...(doctor.resourceIds ?? [])]
            .map((value) => String(value ?? "").trim())
            .filter((value): value is string => value.length > 0)
        )).sort();
        return `${doctor.name}-${idx}|${doctor.locationId}|${doctor.regionId ?? "5"}|${stableCandidates.join(",")}|${machineCtx.city ?? ""}`;
      })
      .join("||");

    if (liveScheduleListKey.current !== scheduleCards) {
      liveScheduleListKey.current = scheduleCards;
      liveDateRequestsInFlight.current.clear();
      liveDateRequestsDone.current.clear();
      setLiveDates({});
      setLiveSlots({});
      setSlotServiceByKey({});
    }

    const controller = new AbortController();
    doctorCards.forEach((doctor, idx) => {
      if (!doctor.locationId) return;
      const locationId = doctor.locationId;
      const key = `${doctor.name}-${idx}`;
      const resourceCandidates = Array.from(new Set(
        [doctor.resourceId, ...(doctor.resourceIds ?? [])]
          .map((value) => String(value ?? "").trim())
          .filter((value): value is string => value.length > 0)
      ));
      if (resourceCandidates.length === 0) return;

      const stableCandidates = [...resourceCandidates].sort();
      const requestKey = `${stableCandidates.join(",")}|${locationId}|${doctor.regionId ?? "5"}|${machineCtx.city ?? ""}`;
      if (liveDateRequestsInFlight.current.has(requestKey) || liveDateRequestsDone.current.has(requestKey)) return;
      liveDateRequestsInFlight.current.add(requestKey);

      const loadLiveSchedule = async () => {
        try {
          let selectedResourceId: string | undefined;
          let selectedDatesResponse: AvailableDatesResponse | undefined;

          for (const candidateResourceId of resourceCandidates) {
            try {
              const d = await getAvailableDates({
                resourceId: candidateResourceId,
                locationId,
                regionId: doctor.regionId ?? "5",
                city: machineCtx.city,
                signal: controller.signal,
              });
              if ((d.dates ?? []).length > 0) {
                selectedResourceId = candidateResourceId;
                selectedDatesResponse = d;
                break;
              }
              if (!selectedDatesResponse) selectedDatesResponse = d;
            } catch {
              // Try next candidate resource ID.
            }
          }

          const parsed: LiveDate[] = (selectedDatesResponse?.dates ?? []).slice(0, 7).map((e) => parseLiveDate(e.display));
          setLiveDates((prev) => ({ ...prev, [key]: parsed }));

          const effectiveResourceId = selectedResourceId ?? resourceCandidates[0];
          const resolvedLocationId = selectedDatesResponse?.locationId ?? locationId;

          if (effectiveResourceId !== doctor.resourceId) {
            setDoctorCards((prev) => {
              let changed = false;
              const next = prev.map((card, cardIdx) => {
                if (cardIdx !== idx) return card;
                if (card.resourceId === effectiveResourceId) return card;
                changed = true;
                return { ...card, resourceId: effectiveResourceId };
              });
              return changed ? next : prev;
            });
          }

          if (selectedDatesResponse?.locationId && selectedDatesResponse.locationId !== locationId) {
            setDoctorCards((prev) =>
              {
                let changed = false;
                const next = prev.map((card, cardIdx) => {
                  if (cardIdx !== idx) return card;
                  if (card.locationId === selectedDatesResponse?.locationId) return card;
                  changed = true;
                  return { ...card, locationId: selectedDatesResponse?.locationId };
                });
                return changed ? next : prev;
              }
            );
          }

          // Auto-load slots for the first available date so live slot API is used immediately.
          const firstDate = parsed[0];
          if (!firstDate) return;
          const slotKey = `${key}||${firstDate.edoc}`;
          setSlotsLoading((prev) => ({ ...prev, [slotKey]: true }));
          try {
            try {
              await getCalendarDetails({
                resourceId: effectiveResourceId,
                locationId: resolvedLocationId,
                regionId: doctor.regionId ?? "5",
                date: firstDate.edoc,
                city: machineCtx.city,
                signal: controller.signal,
              });
            } catch {
              // Keep booking flow alive even if sync-calendar endpoint fails.
            }

            let resolvedServiceId = doctor.serviceId;
            let slotList: string[] = [];
            try {
              const s2 = await getSlotsV2({
                resourceId: effectiveResourceId,
                locationId: resolvedLocationId,
                regionId: doctor.regionId ?? "5",
                date: firstDate.edoc,
                city: machineCtx.city,
                signal: controller.signal,
              });
              slotList = s2.allSlots ?? [];
              if (s2.defaultServiceId) resolvedServiceId = s2.defaultServiceId;
              const slotToServiceId = s2.slotToServiceId ?? {};
              if (Object.keys(slotToServiceId).length > 0) {
                setSlotServiceByKey((prev) => {
                  const next = { ...prev };
                  Object.entries(slotToServiceId).forEach(([slot, serviceId]) => {
                    next[`${slotKey}||${slot}`] = serviceId;
                  });
                  return next;
                });
              }
            } catch {
              slotList = [];
            }

            if (slotList.length === 0) {
              const s = await getSlots({
                resourceId: effectiveResourceId,
                locationId: resolvedLocationId,
                regionId: doctor.regionId ?? "5",
                date: firstDate.edoc,
                city: machineCtx.city,
                signal: controller.signal,
              });
              slotList = s.slots ?? [];
            }

            setLiveSlots((prev) => ({ ...prev, [slotKey]: slotList }));
            if (resolvedServiceId && resolvedServiceId !== doctor.serviceId) {
              setDoctorCards((prev) => {
                let changed = false;
                const next = prev.map((card, cardIdx) => {
                  if (cardIdx !== idx) return card;
                  if (card.serviceId === resolvedServiceId) return card;
                  changed = true;
                  return { ...card, serviceId: resolvedServiceId };
                });
                return changed ? next : prev;
              });
            }
          } catch {
            setLiveSlots((prev) => ({ ...prev, [slotKey]: [] }));
          } finally {
            setSlotsLoading((prev) => ({ ...prev, [slotKey]: false }));
          }
        } catch {
          setLiveDates((prev) => ({ ...prev, [key]: [] }));
        } finally {
          liveDateRequestsInFlight.current.delete(requestKey);
          liveDateRequestsDone.current.add(requestKey);
        }
      };

      void loadLiveSchedule();
    });

    return () => controller.abort();
  }, [currentState, doctorCards, machineCtx.city, getAvailableDates, getCalendarDetails, getSlots, getSlotsV2]);

  useEffect(() => {
    if (currentState === "SHOW_DOCTORS" || currentState === "RESCHEDULE_APPOINTMENT") return;
    liveDateRequestsInFlight.current.clear();
    liveDateRequestsDone.current.clear();
    liveScheduleListKey.current = "";
    noLiveDatesNoticeKey.current = "";
  }, [currentState]);

  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS" && currentState !== "RESCHEDULE_APPOINTMENT") return;
    if (doctorCards.length === 0) return;

    const liveScheduleCards = doctorCards
      .map((doctor, idx) => ({ doctor, idx }))
      .filter(({ doctor }) => !!doctor.locationId && (!!doctor.resourceId || (doctor.resourceIds?.length ?? 0) > 0));
    if (liveScheduleCards.length === 0) return;

    const allLoaded = liveScheduleCards.every(({ doctor, idx }) =>
      Object.prototype.hasOwnProperty.call(liveDates, `${doctor.name}-${idx}`)
    );
    if (!allLoaded) return;

    const allEmpty = liveScheduleCards.every(({ doctor, idx }) =>
      (liveDates[`${doctor.name}-${idx}`] ?? []).length === 0
    );
    if (!allEmpty) return;

    const noticeKey = liveScheduleCards.map(({ doctor, idx }) => `${doctor.name}-${idx}`).join("|");
    if (noLiveDatesNoticeKey.current === noticeKey) return;
    noLiveDatesNoticeKey.current = noticeKey;

    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        sender: "bot",
        text: "I could not find live appointment dates for these doctors right now. Please use Change search to try another branch or city.",
      },
    ]);
  }, [currentState, doctorCards, liveDates]);

  // ── Fetch slots on demand ────────────────────────────────────────────────
  const fetchSlotsForDate = useCallback(async (
    doctorKey: string,
    resourceId: string,
    locationId: string,
    regionId: string,
    edocDate: string,  // "01-JUL-2025"
  ) => {
    const cacheKey = `${doctorKey}||${edocDate}`;
    if (liveSlots[cacheKey] !== undefined) return; // already cached
    setSlotsLoading((prev) => ({ ...prev, [cacheKey]: true }));
    try {
      try {
        await getCalendarDetails({ resourceId, locationId, regionId, date: edocDate, city: machineCtx.city });
      } catch {
        // Keep booking flow alive even if sync-calendar endpoint fails.
      }

      let slotList: string[] = [];
      try {
        const dataV2 = await getSlotsV2({ resourceId, locationId, regionId, date: edocDate, city: machineCtx.city });
        slotList = dataV2.allSlots ?? [];
        const slotToServiceId = dataV2.slotToServiceId ?? {};
        if (Object.keys(slotToServiceId).length > 0) {
          setSlotServiceByKey((prev) => {
            const next = { ...prev };
            Object.entries(slotToServiceId).forEach(([slot, serviceId]) => {
              next[`${cacheKey}||${slot}`] = serviceId;
            });
            return next;
          });
        }
      } catch {
        slotList = [];
      }

      if (slotList.length === 0) {
        const data = await getSlots({ resourceId, locationId, regionId, date: edocDate, city: machineCtx.city });
        slotList = data.slots ?? [];
      }

      setLiveSlots((prev) => ({ ...prev, [cacheKey]: slotList }));
    } catch {
      setLiveSlots((prev) => ({ ...prev, [cacheKey]: [] }));
    } finally {
      setSlotsLoading((prev) => ({ ...prev, [cacheKey]: false }));
    }
  }, [liveSlots, machineCtx.city, getCalendarDetails, getSlots, getSlotsV2]);

  const getServiceIdForSlot = useCallback((doctorKey: string, edocDate: string, slot: string): string | undefined => {
    return slotServiceByKey[`${doctorKey}||${edocDate}||${slot}`];
  }, [slotServiceByKey]);

  // ── EDOC async state side-effects ────────────────────────────────────────

  // Prevent EDOC async effects from double-firing on re-renders
  const edocFiredForState = useRef<string>("");

  // CHECK_EXISTING_APPOINTMENT: check if patient already has an appt with this doctor
  useEffect(() => {
    if (currentState !== "CHECK_EXISTING_APPOINTMENT") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;
    const phone      = machineCtx.phoneNumber;
    const doctorName = machineCtx.doctorName;
    if (!phone || !doctorName) { sendSilentEvent("NO_EXISTING_APPT"); return; }

    fetch("/api/appointments/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, doctorName }),
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { existing?: { apptId?: string; date?: string; time?: string } | null };
        if (d.existing?.apptId) {
          sendSilentEvent(
            "HAS_EXISTING_APPT",
            JSON.stringify({
              apptId: d.existing.apptId,
              date:   d.existing.date ?? "",
              time:   d.existing.time ?? "",
            })
          );
        } else {
          sendSilentEvent("NO_EXISTING_APPT");
        }
      })
      .catch(() => sendSilentEvent("NO_EXISTING_APPT")); // fail-safe: never block booking
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx.phoneNumber, machineCtx.doctorName]);

  // PROCESS_UHID: look up UHID by phone
  useEffect(() => {
    if (currentState !== "PROCESS_UHID") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;
    const phone = machineCtx.phoneNumber;
    if (!phone) { sendSilentEvent("UHID_NOT_FOUND"); return; }

    fetch("/api/edoc/uhid-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, regionId: machineCtx.regionId ?? "5" }),
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { uhidList?: Array<{ UHIDNumber?: string }> };
        const uhid = d.uhidList?.[0]?.UHIDNumber;
        if (uhid) {
          sendSilentEvent("UHID_FOUND", uhid);
        } else {
          sendSilentEvent("UHID_NOT_FOUND");
        }
      })
      .catch(() => sendSilentEvent("UHID_NOT_FOUND"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx.phoneNumber]);

  // GENERATE_UHID_STATE: create new patient record
  useEffect(() => {
    if (currentState !== "GENERATE_UHID_STATE") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;
    const { patientFirstName, patientLastName, patientDob, phoneNumber, locationId, regionId } = machineCtx;
    if (!patientFirstName || !phoneNumber) { sendSilentEvent("UHID_FAILED"); return; }
    const safeLocationId = getSafeLocationId(locationId);

    // Normalize DOB to DD-Mon-YYYY — EDOC rejects numeric months like "14-03-2004"
    const MON_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const normalizeEdocDob = (dob: string): string => {
      const m = dob.match(/^(\d{1,2})[-/](\d{1,2}|\w{3,})[-/](\d{2,4})$/);
      if (!m) return dob;
      const [, d, mon, y] = m;
      const idx = parseInt(mon) - 1;
      const monName = !isNaN(idx) && idx >= 0 && idx < 12 ? MON_NAMES[idx] : mon;
      return `${d.padStart(2, "0")}-${monName}-${y}`;
    };
    const normalizedDob = normalizeEdocDob(patientDob ?? "01-Jan-1990");

    fetch("/api/edoc/generate-uhid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        RegistrationTypes: "FreeUHID",
        Title: "1",
        LocationID: safeLocationId,
        RegionID: Number(regionId ?? "5"),
        FirstName: patientFirstName,
        LastName: patientLastName ?? "User",
        DateOfBirth: normalizedDob,
        MobileNumber: phoneNumber,
        Gender: "71",
        MaritalStatus: "8",
        Country: "97",
        Flag: "1",
        REGULARIZATIONCHECK: "0",
        InternationalPatientFlag: false,
        logID: crypto.randomUUID(),
        ModeofAppointment: "Apollo Assist Web",
        RegAuthConsent: { PatientorAttendentName: "", PatientorAttendentAge: "0", NextofKinName: "", Resident: "", IpAddress: "", ConsentStatus: "", ConsentCreatedDate: "" },
      }),
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { uhid?: string; retcode?: number };
        if (d.uhid) {
          sendSilentEvent("UHID_GENERATED", d.uhid);
        } else {
          sendSilentEvent("UHID_FAILED");
        }
      })
      .catch(() => sendSilentEvent("UHID_FAILED"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState]);

  // PROCESS_BOOKING: call BookAppointment
  useEffect(() => {
    if (currentState !== "PROCESS_BOOKING") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;
    const { resourceId, locationId, regionId, serviceId, uhid, selectedDate, selectedSlotStart, phoneNumber } = machineCtx;

    // "Request Appointment" path — no date/slot selected, just send BOOKING_DONE
    // with a placeholder so the user gets a confirmation message
    if (!selectedDate || !selectedSlotStart) {
      sendSilentEvent("BOOKING_DONE", "REQUEST");
      return;
    }

    if (!resourceId || !uhid) {
      sendSilentEvent("BOOKING_FAILED");
      return;
    }
    const safeLocationId = getSafeLocationId(locationId);

    const runBookAppointment = async () => {
      try {
        const { StartDateTime, EndDateTime } = formatSlot(selectedDate, selectedSlotStart);
        const payload: Record<string, unknown> = {
          RegistrationType: "QuickUHID",
          LocationID: safeLocationId,
          RegionID: Number(regionId ?? "5"),
          ResourceID: resourceId,
          UHIDNumber: uhid,
          ServiceID: serviceId ?? "0",
          FirstName: machineCtx.patientFirstName ?? "Patient",
          LastName: machineCtx.patientLastName ?? "User",
          SpecialityID: "0",
          Country: "0",
          State: "0",
          StatusCheck: "102",
          MobileNumber: phoneNumber ?? "0000000000",
          District: "0",
          Gender: "71",
          City: "0",
          AddressTypeID: "0",
          Flag: "0",
          REGULARIZATIONCHECK: "0",
          StartDateTime,
          EndDateTime,
          InternationalPatientFlag: false,
          logID: crypto.randomUUID(),
          ModeofAppointment: "Ask Apollo Web",
        };
        const d = await bookAppointment(payload);
        if (d.AppointmentID !== undefined && d.retcode === 0) {
          setConversationSummary((prev) => buildSummary(prev, {
            type: "booking_done",
            doctorName: machineCtx.doctorName,
            specialty: machineCtx.specialty,
            city: machineCtx.city,
            branch: machineCtx.branch,
            date: machineCtx.selectedDate,
            time: machineCtx.selectedSlotStart,
            appointmentId: String(d.AppointmentID),
          }));
          void updateSummaryWithLlm();
          sendSilentEvent("BOOKING_DONE", String(d.AppointmentID));
        } else {
          logEdoc("BookAppointment.retcode_failure", { response: d });
          sendSilentEvent("BOOKING_FAILED");
        }
      } catch (err: unknown) {
        logEdoc("BookAppointment.exception", { error: String(err) });
        sendSilentEvent("BOOKING_FAILED");
      }
    };

    void runBookAppointment();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, formatSlot, bookAppointment, logEdoc]);

  // PROCESS_RESCHEDULE: call ResheduleAppointment
  useEffect(() => {
    if (currentState !== "PROCESS_RESCHEDULE") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;
    const { appointmentId, locationId, regionId, resourceId, selectedDate, selectedSlotStart, selectedSlotEnd } = machineCtx;
    if (!appointmentId || !selectedDate || !selectedSlotStart) {
      sendSilentEvent("RESCHEDULE_FAILED");
      return;
    }
    const safeLocationId = getSafeLocationId(locationId);
    const startDT = `${selectedDate} ${selectedSlotStart}:00`;
    const endDT   = `${selectedDate} ${selectedSlotEnd ?? addFifteenMin(selectedSlotStart)}:00`;

    fetch("/api/edoc/reschedule-appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        AppointmentID: Number(appointmentId),
        LocationID: safeLocationId,
        ResourceID: Number(resourceId ?? "0"),
        StartDateTime: startDT,
        EndDateTime: endDT,
        Notes: "Reschedule via Apollo Assist",
        ReasonforReschedule: "Patient requested reschedule",
        UpdatedBy: resourceId ?? "0",
        RegionID: Number(regionId ?? "5"),
      }),
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { retcode?: number };
        if (d.retcode === 0) {
          sendSilentEvent("RESCHEDULE_DONE", appointmentId);
        } else {
          sendSilentEvent("RESCHEDULE_FAILED");
        }
      })
      .catch(() => sendSilentEvent("RESCHEDULE_FAILED"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState]);

  // PROCESS_CANCEL: call CancelAppointment
  useEffect(() => {
    if (currentState !== "PROCESS_CANCEL") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;
    const { appointmentId, locationId, regionId, resourceId } = machineCtx;
    if (!appointmentId) { sendSilentEvent("CANCEL_DONE"); return; }
    const safeLocationId = getSafeLocationId(locationId);

    fetch("/api/edoc/cancel-appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        LocationID: safeLocationId,
        RegionID: Number(regionId ?? "5"),
        ReasonforCancellation: "Patient cancelled via Apollo Assist",
        AppointmentID: Number(appointmentId),
        UpdatedBy: resourceId ?? "0",
      }),
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { retcode?: number };
        sendSilentEvent(d.retcode === 0 ? "CANCEL_DONE" : "CANCEL_FAILED");
      })
      .catch(() => sendSilentEvent("CANCEL_FAILED"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState]);

  // ── LLM response ──────────────────────────────────────────────────────────
  // States where LLM adds no value (auto-transitions, loading spinners, error states)

  const pushLlmBotMessage = useCallback(async (state: string, ctx: Record<string, unknown>, userMessage: string) => {
    // Skip LLM for transient/loading/error states — use static response directly
    if (NO_LLM_STATES.has(state)) {
      pushStaticBotMessage(state, ctx as ChatContext);
      return;
    }
    await pushLlmDirect(state, ctx, userMessage);
  }, [pushStaticBotMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Call LLM unconditionally — bypasses NO_LLM_STATES check (used for in-place responses). */
  const pushLlmDirect = useCallback(async (state: string, ctx: Record<string, unknown>, userMessage: string) => {
    // Build recent conversation history (up to 8 prior turns, excluding the current user msg)
    const recentMsgs = messagesRef.current.slice(-9, -1);
    const history = recentMsgs
      .filter((m) => m.text.trim().length > 0)
      .map((m) => ({ role: m.sender === "user" ? "user" : "assistant" as "user" | "assistant", text: m.text }));
    try {
      setIsLlmLoading(true);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": sessionIdRef.current },
        body: JSON.stringify({
          currentState: state,
          context: ctx,
          userMessage,
          history,
          summary: conversationSummaryRef.current || undefined,
          userLanguage: userLanguageRef.current !== "en" ? userLanguageRef.current : undefined,
        }),
      });
      if (res.status === 429) {
        const data = await res.json() as { retryAfter?: number };
        setRateLimitSeconds(data.retryAfter ?? 15);
        setIsLlmLoading(false);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { text: string | null };
        if (data.text) {
          setMessages((prev) => [...prev, { id: nextId(), sender: "bot", text: data.text as string }]);
          return;
        }
        // text:null means Gemini failed server-side — fall through to static
      }
    } catch { /* fall through */ } finally {
      setIsLlmLoading(false);
    }
    pushStaticBotMessage(state, ctx as ChatContext);
  }, [pushStaticBotMessage]);

  // ── Quick-reply / programmatic events ─────────────────────────────────────
  const sendEvent = useCallback(
    (eventType: string, value?: string) => {
      const runner = runnerRef.current;
      if (!runner) return;
      const event = (value !== undefined ? { type: eventType, value } : { type: eventType }) as AppEvent;
      runner.sendEvent(event);
      const nextState = runner.currentState;
      const nextCtx = runner.context as ChatContext;
      // Reset EDOC fire guard when state changes (same as sendSilentEvent)
      if (nextState !== edocFiredForState.current) {
        edocFiredForState.current = "";
      }
      setCurrentState(nextState);
      setMachineCtx(nextCtx);
      pushStaticBotMessage(nextState, nextCtx);
    },
    [pushStaticBotMessage]
  );

  // ── AI: parse intent and auto-navigate ────────────────────────────────────
  const tryAiIntent = useCallback(async (text: string): Promise<boolean> => {
    const runner = runnerRef.current;
    if (!runner) return false;
    try {
      const { allCities: cities, specialities } = await import("../knowledgeBase.js");
      // Pass last 6 messages as history so intent parser can resolve "yes"/"sure"/"ok" from prior context
      const history = messagesRef.current.slice(-6).map((m) => ({
        role: (m.sender === "user" ? "user" : "assistant") as "user" | "assistant",
        text: m.text,
      }));
      const res = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, cities, specialties: specialities, history, currentState }),
      });
      if (!res.ok) return false;
      const parsed = await res.json() as {
        intent: string;
        specialty?: string | null;
        city?: string | null;
        branch?: string | null;
        doctorName?: string | null;
        symptomText?: string | null;
      };
      // ── CHANGE DOCTOR: user wants a specific doctor while cards are shown ──────
      if (parsed.intent === "change_doctor" && currentState === "SHOW_DOCTORS" && parsed.doctorName) {
        const nameQuery = parsed.doctorName.trim();
        const params = new URLSearchParams({ name: nameQuery });
        if (machineCtx.specialty) params.set("specialty", machineCtx.specialty);
        if (machineCtx.city)      params.set("city",      machineCtx.city);
        if (machineCtx.branch)    params.set("branch",    machineCtx.branch);

        let found: Array<{
          name: string; specialty?: string; hospital?: string;
          resourceId?: string; resourceIds?: string[];
          locationId?: string; regionId?: string; serviceId?: string;
        }> = [];
        try {
          const doctorRes = await fetch(`/api/doctors?${params.toString()}`);
          if (doctorRes.ok) {
            const doctorData = (await doctorRes.json()) as {
              doctors?: typeof found;
            };
            found = doctorData.doctors ?? [];
          }
        } catch { /* fall through to not-found path */ }

        if (found.length > 0) {
          const doc = found[0];
          const parts: string[] = [];
          if (doc.specialty ?? machineCtx.specialty) parts.push((doc.specialty ?? machineCtx.specialty) as string);
          if (machineCtx.branch) parts.push(machineCtx.branch);
          if (machineCtx.city)   parts.push(machineCtx.city);
          const detail = parts.filter(Boolean).join(", ");
          const confirmMsg = detail
            ? `Got it! Found ${doc.name} (${detail}).`
            : `Got it! Found ${doc.name}.`;
          const noticeId = nextId();
          setMessages((prev) => [...prev, { id: noticeId, sender: "bot", text: confirmMsg }]);
          const hospital = machineCtx.branch
            ? `${machineCtx.branch}${machineCtx.city ? `, ${machineCtx.city}` : ""}`
            : machineCtx.city ? `Apollo Hospitals, ${machineCtx.city}` : "Apollo Hospitals";
          setDoctorCards(found.slice(0, 1).map((d) => ({
            name:        d.name,
            specialty:   d.specialty ?? machineCtx.specialty,
            hospital:    d.hospital  ?? hospital,
            resourceId:  d.resourceId,
            resourceIds: d.resourceIds,
            locationId:  d.locationId,
            regionId:    d.regionId ?? "5",
            serviceId:   d.serviceId,
          })));
          setCardsAnchorMsgId(noticeId);
        } else {
          const notFoundMsg = `I couldn't find a doctor matching "${nameQuery}" in this search. Would you like to look for a different doctor?`;
          setMessages((prev) => [...prev, { id: nextId(), sender: "bot", text: notFoundMsg }]);
          runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
          const nextState = runner.currentState;
          const nextCtx   = runner.context as ChatContext;
          if (nextState !== edocFiredForState.current) edocFiredForState.current = "";
          setCurrentState(nextState);
          setMachineCtx(nextCtx);
          pushStaticBotMessage(nextState, nextCtx);
        }
        return true;
      }

      const isActionable = (parsed.intent === "book_appointment" || parsed.intent === "find_doctor")
        && (parsed.specialty || parsed.doctorName || parsed.city);
      const isSymptom = parsed.intent === "have_symptoms" && !!(parsed.symptomText || parsed.specialty);
      if (!isActionable && !isSymptom) return false;

      if (isSymptom) {
        const symptomSpecialty = parsed.specialty;
        const symptomText = parsed.symptomText ?? "";

        if (symptomSpecialty) {
          // Specialty known — use AI_PREFILL to route directly through specialty search.
          // Works in WELCOME/MAIN_MENU/FALLBACK/BOOK_APPT_OPTIONS/FIND_DOCTOR_OPTIONS/BOOK_APPT_OPTIONS_LOCATION
          const prefill = JSON.stringify({
            specialty: symptomSpecialty,
            city: parsed.city ?? undefined,
          });
          runner.sendEvent({ type: "AI_PREFILL", value: prefill } as AppEvent);
        } else {
          // No specialty mapping — navigate step by step:
          // HAVE_SYMPTOMS → ASK_BASIC_DETAILS → ENTER_SYMPTOM → MAP_TO_SPECIALTY
          const stateBefore = runner.currentState;
          runner.sendEvent({ type: "HAVE_SYMPTOMS" } as AppEvent);
          // FIND_DOCTOR_OPTIONS uses BY_SYMPTOMS instead of HAVE_SYMPTOMS
          if (runner.currentState === stateBefore) {
            runner.sendEvent({ type: "BY_SYMPTOMS" } as AppEvent);
          }
          if (runner.currentState === "ASK_BASIC_DETAILS") {
            runner.sendEvent({ type: "ENTER_SYMPTOM", value: symptomText } as AppEvent);
          }
        }
        const nextState = runner.currentState;
        const nextCtx   = runner.context as ChatContext;
        if (nextState !== edocFiredForState.current) edocFiredForState.current = "";
        setCurrentState(nextState);
        setMachineCtx(nextCtx);
        pushStaticBotMessage(nextState, nextCtx);
        return true;
      }

      const payload = JSON.stringify({
        specialty:  parsed.specialty  ?? undefined,
        city:       parsed.city       ?? undefined,
        branch:     parsed.branch     ?? undefined,
        doctorName: parsed.doctorName ?? undefined,
      });
      runner.sendEvent({ type: "AI_PREFILL", value: payload });
      const nextState = runner.currentState;
      const nextCtx   = runner.context as ChatContext;
      if (nextState !== edocFiredForState.current) edocFiredForState.current = "";
      setCurrentState(nextState);
      setMachineCtx(nextCtx);
      pushStaticBotMessage(nextState, nextCtx);
      return true;
    } catch {
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, pushStaticBotMessage]);

  // ── Agent-decision pipeline ────────────────────────────────────────────────
  //
  // callAgentDecide   → fetches /api/agent/decide, returns AgentDecision | null
  // executeAgentDecision → maps action+targetWorkflow to machine events / tool calls
  // tryAgentDecide    → combines both; falls back to tryAiIntent on network failure

  /**
   * Calls POST /api/agent/decide with current session context.
   * Returns null on any network/parse error — never throws.
   */
  const callAgentDecide = useCallback(async (text: string): Promise<AgentDecision | null> => {
    try {
      const history = messagesRef.current.slice(-8).map((m) => ({
        role: (m.sender === "user" ? "user" : "assistant") as "user" | "assistant",
        text: m.text,
      }));
      const res = await fetch("/api/agent/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": sessionIdRef.current },
        body: JSON.stringify({
          currentState,
          machineContext: machineCtx,
          userMessage: text,
          history,
          summary: conversationSummaryRef.current || undefined,
          userLanguage: userLanguageRef.current !== "en" ? userLanguageRef.current : undefined,
        }),
      });
      if (res.status === 429) {
        const data = await res.json() as { retryAfter?: number };
        setRateLimitSeconds(data.retryAfter ?? 15);
        return null;
      }
      if (!res.ok) return null;
      const decision = await res.json() as AgentDecision;
      console.info(
        `[AGENT] state="${currentState}" userMessageLength=${text.length} → ` +
        `action="${decision.action}" workflow="${decision.targetWorkflow ?? "-"}" ` +
        `confidence=${decision.confidence}`
      );
      return decision;
    } catch (err) {
      console.warn("[AGENT] callAgentDecide failed:", err);
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx]);

  /**
   * Given an AgentDecision, maps it to XState events / tool calls.
   * Returns true if the agent handled the turn; false to fall through to
   * the deterministic (tryAiIntent → mapInputToEvent) pipeline.
   *
   * SAFETY CONTRACT:
   *   - Never calls EDOC APIs directly.
   *   - Never mutates patient DB.
   *   - All transactional work stays in the XState machine + dedicated API routes.
   */
  const executeAgentDecision = useCallback(async (
    decision: AgentDecision,
  ): Promise<boolean> => {
    const runner = runnerRef.current;
    if (!runner) return false;

    const { action, targetWorkflow, confidence, entities } = decision;

    // Below-threshold or explicit continue — let the deterministic fallback handle it
    if (
      action === "CONTINUE_WORKFLOW" ||
      (confidence < 0.6 && action !== "ASK_CLARIFICATION" && action !== "RESET_FLOW")
    ) {
      return false;
    }

    // ── Helper: navigate to a state that accepts AI_PREFILL ─────────────────
    const ensureAiPrefillReady = () => {
      if (AI_PREFILL_STATES.has(runner.currentState)) return;
      runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
      // Some states (e.g. ENTER_PHONE_FOR_BOOKING) go to SHOW_DOCTORS, not MAIN_MENU
      if (!AI_PREFILL_STATES.has(runner.currentState)) {
        runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
      }
    };

    // ── Helper: commit state after machine transition ────────────────────────
    const commitState = () => {
      const nextState = runner.currentState;
      const nextCtx = runner.context as ChatContext;
      if (nextState !== edocFiredForState.current) edocFiredForState.current = "";
      setCurrentState(nextState);
      setMachineCtx(nextCtx);
      console.info(`[AGENT] Transitioned → state="${nextState}"`);
      pushStaticBotMessage(nextState, nextCtx);
    };

    // ── ASK_CLARIFICATION ────────────────────────────────────────────────────
    if (action === "ASK_CLARIFICATION") {
      const question = decision.reason || "Could you clarify what you're looking for?";
      setMessages((prev) => [...prev, { id: nextId(), sender: "bot", text: question }]);
      console.info("[AGENT] ASK_CLARIFICATION emitted");
      return true;
    }

    // ── RESET_FLOW ───────────────────────────────────────────────────────────
    if (action === "RESET_FLOW") {
      runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
      if (runner.currentState !== "MAIN_MENU") {
        runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
      }
      console.info("[AGENT] RESET_FLOW → MAIN_MENU");
      commitState();
      return true;
    }

    // ── CALL_TOOL: CHANGE_DOCTOR (inline doctor card swap) ───────────────────
    if (action === "CALL_TOOL" && targetWorkflow === "CHANGE_DOCTOR") {
      const nameQuery = (entities.doctorName ?? "").trim();
      if (!nameQuery) return false;

      // Fresh entities overwrite; null fields use machineCtx so context search filters still work
      const useSpecialty = entities.specialty ?? machineCtx.specialty;
      const useCity      = entities.city      ?? machineCtx.city;
      const useBranch    = entities.branch    ?? machineCtx.branch;

      const params = new URLSearchParams({ name: nameQuery });
      if (useSpecialty) params.set("specialty", useSpecialty);
      if (useCity)      params.set("city",      useCity);
      if (useBranch)    params.set("branch",    useBranch);

      console.info("[AGENT] CALL_TOOL CHANGE_DOCTOR");

      let found: DoctorCardData[] = [];
      try {
        const r = await fetch(`/api/doctors?${params.toString()}`);
        if (r.ok) {
          const data = await r.json() as { doctors?: DoctorCardData[] };
          found = (data.doctors ?? []).slice(0, 1);
        }
      } catch { /* fall through to not-found path */ }

      const noticeId = nextId();
      if (found.length > 0) {
        const doc = found[0];
        const detailParts = [doc.specialty ?? useSpecialty, useBranch, useCity].filter(Boolean);
        const detail = detailParts.join(", ");
        setMessages((prev) => [
          ...prev,
          {
            id: noticeId,
            sender: "bot",
            text: detail ? `Got it! Found ${doc.name} (${detail}).` : `Got it! Found ${doc.name}.`,
          },
        ]);
        const hospital = useBranch
          ? `${useBranch}${useCity ? `, ${useCity}` : ""}`
          : useCity ? `Apollo Hospitals, ${useCity}` : "Apollo Hospitals";
        setDoctorCards([{
          name:        doc.name,
          specialty:   doc.specialty ?? useSpecialty,
          hospital:    doc.hospital  ?? hospital,
          resourceId:  doc.resourceId,
          resourceIds: doc.resourceIds,
          locationId:  doc.locationId,
          regionId:    doc.regionId ?? "5",
          serviceId:   doc.serviceId,
        }]);
        setCardsAnchorMsgId(noticeId);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: noticeId, sender: "bot", text: `I couldn't find "${nameQuery}". Try a different name or use Change search?` },
        ]);
        // Reset to menu so the user can try a new search
        runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
        if (runner.currentState !== "MAIN_MENU") runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
        commitState();
      }
      return true;
    }

    // ── SWITCH_WORKFLOW / CALL_TOOL (all other workflows) ───────────────────
    if (action === "SWITCH_WORKFLOW" || action === "CALL_TOOL") {
      // Build AI_PREFILL payload from ONLY the entities the user mentioned right now.
      // Null fields are intentionally excluded — no stale context bleed.
      const freshPrefill: Record<string, string> = {};
      if (entities.doctorName)  freshPrefill.doctorName = entities.doctorName;
      if (entities.specialty)   freshPrefill.specialty  = entities.specialty;
      if (entities.city)        freshPrefill.city       = entities.city;
      if (entities.branch)      freshPrefill.branch     = entities.branch;

      console.info(`[AGENT] ${action} → workflow="${targetWorkflow ?? "-"}"`, maskSensitiveData(freshPrefill));

      // ── Workflows that don't go through AI_PREFILL ─────────────────────────

      if (targetWorkflow === "EMERGENCY") {
        runner.sendEvent({ type: "EMERGENCY" } as AppEvent);
        commitState();
        return true;
      }

      if (targetWorkflow === "MAIN_MENU") {
        runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
        if (runner.currentState !== "MAIN_MENU") runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
        commitState();
        return true;
      }

      if (targetWorkflow === "HEALTH_CHECKUP") {
        const before = runner.currentState;
        runner.sendEvent({ type: "HEALTH_CHECKUP" } as AppEvent);
        if (runner.currentState === before) {
          // State didn't accept HEALTH_CHECKUP — navigate to menu first
          runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
          if (runner.currentState !== "MAIN_MENU") runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
          runner.sendEvent({ type: "HEALTH_CHECKUP" } as AppEvent);
        }
        if (entities.city && runner.currentState === "HEALTH_CHECKUP_ENTRY") {
          runner.sendEvent({ type: "ENTER_CITY", value: entities.city } as AppEvent);
        }
        commitState();
        return true;
      }

      if (targetWorkflow === "BOOK_BY_LOCATION") {
        const before = runner.currentState;
        runner.sendEvent({ type: "BOOK_BY_LOCATION" } as AppEvent);
        if (runner.currentState === before) {
          runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
          if (runner.currentState !== "MAIN_MENU") runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
          runner.sendEvent({ type: "BOOK_BY_LOCATION" } as AppEvent);
        }
        if (entities.city && runner.currentState === "ASK_CITY_FOR_LOCATION") {
          runner.sendEvent({ type: "ENTER_CITY", value: entities.city } as AppEvent);
        }
        // Capture the state after potential ENTER_CITY (annotate as string to break TS narrowing)
        const stateAfterLocationSend: string = runner.currentState;
        if (entities.branch && stateAfterLocationSend === "ASK_BRANCH_FOR_LOCATION") {
          runner.sendEvent({ type: "SELECT_BRANCH", value: entities.branch } as AppEvent);
        }
        commitState();
        return true;
      }

      // ── SYMPTOM_TRIAGE ───────────────────────────────────────────────────
      if (targetWorkflow === "SYMPTOM_TRIAGE") {
        const symptomText = entities.symptomText ?? "";
        let resolvedSpecialty: string | null = entities.specialty ?? null;

        // If the agent didn't extract a specialty, try the static map first
        if (!resolvedSpecialty && symptomText) {
          const { mapSymptomToSpecialty } = await import("../knowledgeBase.js");
          resolvedSpecialty = mapSymptomToSpecialty(symptomText);
        }

        // If still no specialty, ask the LLM symptom-specialty endpoint
        if (!resolvedSpecialty && symptomText) {
          try {
            const { specialities } = await import("../knowledgeBase.js");
            const res = await fetch("/api/symptom-specialty", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ symptom: symptomText, specialties: specialities }),
            });
            if (res.ok) {
              const data = await res.json() as { specialty?: string | null };
              resolvedSpecialty = data.specialty ?? null;
            }
          } catch { /* fall through to navigation path */ }
        }

        if (resolvedSpecialty) {
          // Specialty resolved — route directly with AI_PREFILL (fastest path to doctors)
          ensureAiPrefillReady();
          runner.sendEvent({
            type: "AI_PREFILL",
            value: JSON.stringify({
              specialty: resolvedSpecialty,
              ...(entities.city   ? { city:   entities.city }   : {}),
              ...(entities.branch ? { branch: entities.branch } : {}),
            }),
          } as AppEvent);
        } else if (runner.currentState === "SELECT_SYMPTOM_CATEGORY" && symptomText) {
          // Already in symptom flow — fire ENTER_SYMPTOM_TEXT so the machine handles it
          runner.sendEvent({ type: "ENTER_SYMPTOM_TEXT", value: symptomText } as AppEvent);
        } else {
          // No specialty and not at symptom screen — navigate to symptom entry flow
          const before = runner.currentState;
          runner.sendEvent({ type: "HAVE_SYMPTOMS" } as AppEvent);
          if (runner.currentState === before) runner.sendEvent({ type: "BY_SYMPTOMS" } as AppEvent);
          if (runner.currentState === before) {
            runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
            if (runner.currentState !== "MAIN_MENU") runner.sendEvent({ type: "BACK_TO_MENU" } as AppEvent);
            runner.sendEvent({ type: "BOOK_APPOINTMENT" } as AppEvent);
            runner.sendEvent({ type: "HAVE_SYMPTOMS" } as AppEvent);
          }
          if (runner.currentState === "ASK_BASIC_DETAILS" && symptomText) {
            runner.sendEvent({ type: "ENTER_SYMPTOM", value: symptomText } as AppEvent);
          }
        }
        commitState();
        return true;
      }

      // ── All remaining workflows: BOOK_BY_NAME, BOOK_BY_SPECIALTY, FIND_DOCTOR ──
      // AI_PREFILL_ROUTE in the machine handles the rest based on which entities are present.
      if (Object.keys(freshPrefill).length > 0) {
        ensureAiPrefillReady();
        runner.sendEvent({ type: "AI_PREFILL", value: JSON.stringify(freshPrefill) } as AppEvent);
        commitState();
        return true;
      }

      // No usable entities extracted — fall through to deterministic pipeline
      return false;
    }

    return false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx, pushStaticBotMessage, setDoctorCards, setCardsAnchorMsgId]);

  /**
   * Primary entry point for agent-orchestrated turns.
   * 1. Calls callAgentDecide (Gemini)
   * 2. On success: executes the decision
   * 3. On network failure: falls back to tryAiIntent (legacy intent parser)
   */
  const tryAgentDecide = useCallback(async (text: string): Promise<boolean> => {
    const decision = await callAgentDecide(text);
    if (!decision) {
      // Agent unavailable — fall back to the legacy intent parser
      console.warn("[AGENT] callAgentDecide returned null, falling back to tryAiIntent");
      return tryAiIntent(text);
    }
    return executeAgentDecision(decision);
  }, [callAgentDecide, executeAgentDecision, tryAiIntent]);

  // ── Free-text input ────────────────────────────────────────────────────────
  const sendUserText = useCallback(
    async (text: string) => {
      const runner = runnerRef.current;
      if (!runner) return;
      setMessages((prev) => [...prev, { id: nextId(), sender: "user", text }]);

      // ── Language detection ─────────────────────────────────────────────────
      // Sync heuristic first (instant) so the current turn's LLM call benefits;
      // async LLM detection runs in background for romanized scripts.
      const scriptLang = detectScriptLanguage(text);
      if (scriptLang && scriptLang !== userLanguageRef.current) {
        userLanguageRef.current = scriptLang;
        setUserLanguage(scriptLang);
      } else if (!scriptLang && text.trim().length >= 4) {
        // Await detection before proceeding — guarantees the correct language code
        // is in userLanguageRef before the LLM call is made this turn.
        await detectAndSetLanguage(text);
      }

      // ── SHOW_DOCTORS: keep cards visible; explicit keywords take priority ──
      if (currentState === "SHOW_DOCTORS") {
        const event = mapInputToEvent(text, currentState);
        if (event.type !== "UNKNOWN") {
          // Explicit keyword navigation (CHANGE_SEARCH / BACK_TO_MENU)
          runner.sendEvent(event);
          const nextState = runner.currentState;
          const nextCtx = runner.context as ChatContext;
          if (nextState !== "SHOW_DOCTORS") {
            // State actually changed — commit and show new state message
            if (nextState !== edocFiredForState.current) edocFiredForState.current = "";
            setCurrentState(nextState);
            setMachineCtx(nextCtx);
            await pushLlmBotMessage(nextState, nextCtx as Record<string, unknown>, text);
          } else {
            // Machine didn't accept the event (state unchanged) — treat as conversational
            const navigated = await tryAgentDecide(text);
            if (!navigated) {
              await pushLlmDirect(currentState, runner.context as Record<string, unknown>, text);
            }
          }
        } else {
          // Agent-decide pipeline handles intent (doctor swap, specialty change, etc.)
          const navigated = await tryAgentDecide(text);
          if (!navigated) {
            // Purely conversational — respond in-place without leaving SHOW_DOCTORS
            await pushLlmDirect(currentState, runner.context as Record<string, unknown>, text);
          }
        }
        return;
      }

      // ── AGENT_DECIDE_STATES: agent runs first on every free-text turn ─────
      if (AGENT_DECIDE_STATES.has(currentState)) {
        const navigated = await tryAgentDecide(text);
        if (navigated) return;

        // ── Deterministic fallback 1: legacy AI intent parser (for AI_NAV_STATES) ──
        if (AI_NAV_STATES.includes(currentState)) {
          const legacyNavigated = await tryAiIntent(text);
          if (legacyNavigated) return;
          // No name heuristic here — let it fall through to mapInputToEvent/pushLlmDirect
          // so conversational messages get a warm LLM response rather than a bad doctor search
        }
      }

      // ── Deterministic fallback: mapInputToEvent (all states) ─────────────
      const event = mapInputToEvent(text, currentState);
      runner.sendEvent(event);
      const nextState = runner.currentState;
      const nextCtx = runner.context as ChatContext;
      if (nextState !== edocFiredForState.current) {
        edocFiredForState.current = "";
      }
      if (nextState !== currentState) {
        // State changed — commit and show the new state's message
        setCurrentState(nextState);
        setMachineCtx(nextCtx);
        await pushLlmBotMessage(nextState, runner.context as Record<string, unknown>, text);
      } else {
        // Machine didn't accept the event (state unchanged) — respond in-place with LLM
        // rather than blindly re-pushing the same state message.
        await pushLlmDirect(currentState, runner.context as Record<string, unknown>, text);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentState, pushLlmBotMessage, pushLlmDirect, tryAgentDecide, tryAiIntent, detectAndSetLanguage]
  );

  /**
   * Fire-and-forget: logs a structured button interaction to the audit DB.
   * Never throws — DB failures must not affect chatbot UX.
   */
  const logInteraction = useCallback(
    (message: string, messageType: string, buttonLabel?: string, buttonValue?: string) => {
      void fetch("/api/log-interaction", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": sessionIdRef.current },
        body: JSON.stringify({ message, messageType, buttonLabel, buttonValue, machineState: currentState }),
      }).catch((err) => {
        console.warn("[CHAT] Failed to persist interaction:", err);
      });
    },
    [currentState]
  );

  const sendQuickReply = useCallback(
    (label: string, eventType: string, value?: string) => {
      setMessages((prev) => [...prev, { id: nextId(), sender: "user", text: label }]);
      logInteraction(label, "quick_reply", label, eventType);
      sendEvent(eventType, value);
    },
    [sendEvent, logInteraction]
  );

  /**
   * Called from the doctor card "Book appointment" button.
   * Encodes slot details as JSON and fires SELECT_SLOT.
   */
  const selectDoctorForBooking = useCallback(
    (doctor: DoctorCardData, edocDate: string, startTime: string, serviceIdOverride?: string) => {
      const endTime = addFifteenMin(startTime);
      const payload = JSON.stringify({
        date:       edocDate,
        startTime,
        endTime,
        resourceId: doctor.resourceId,
        locationId: doctor.locationId,
        regionId:   doctor.regionId ?? "5",
        serviceId:  serviceIdOverride ?? doctor.serviceId,
        doctorName: doctor.name,
      });
      setMessages((prev) => [
        ...prev,
        { id: nextId(), sender: "user", text: `Book ${doctor.name} · ${edocDate} at ${startTime}` },
      ]);
      setConversationSummary((prev) => buildSummary(prev, {
        type: "doctor_selected",
        doctorName: doctor.name,
        specialty: doctor.specialty,
        city: machineCtx.city,
        branch: machineCtx.branch,
        date: edocDate,
        time: startTime,
      }));
      logInteraction(
        `Book ${doctor.name} · ${edocDate} at ${startTime}`,
        "slot_selection",
        `${doctor.name} · ${edocDate} at ${startTime}`,
        "SELECT_SLOT"
      );
      sendEvent("SELECT_SLOT", payload);
    },
    [sendEvent, logInteraction, machineCtx.city, machineCtx.branch]
  );

  /**
   * Called from the "Request Appointment" button when no slots are available.
   * Sets doctor context and starts the phone-entry flow without a specific slot.
   */
  const requestAppointmentForDoctor = useCallback(
    (doctor: DoctorCardData) => {
      const payload = JSON.stringify({
        date: "",
        startTime: "",
        endTime: "",
        resourceId: doctor.resourceId,
        locationId: doctor.locationId,
        regionId:   doctor.regionId ?? "5",
        serviceId:  doctor.serviceId,
        doctorName: doctor.name,
      });
      setMessages((prev) => [
        ...prev,
        { id: nextId(), sender: "user", text: `Request appointment with ${doctor.name}` },
      ]);
      setConversationSummary((prev) => buildSummary(prev, {
        type: "booking_requested",
        doctorName: doctor.name,
        specialty: doctor.specialty,
        city: machineCtx.city,
        branch: machineCtx.branch,
      }));
      logInteraction(
        `Request appointment with ${doctor.name}`,
        "doctor_selection",
        doctor.name,
        "SELECT_SLOT"
      );
      sendEvent("SELECT_SLOT", payload);
    },
    [sendEvent, logInteraction, machineCtx.city, machineCtx.branch]
  );

  const resetMachine = useCallback(() => {
    const runner = runnerRef.current;
    if (runner) runner.stop();
    const newRunner = new ApolloAssistRunner();
    runnerRef.current = newRunner;
    const initial = newRunner.currentState;
    edocFiredForState.current = "";
    setCurrentState(initial);
    setMachineCtx({});
    setIsLlmLoading(false);
    setDoctorCards([]);
    setCardsAnchorMsgId(null);
    setConversationSummary("");
    setLiveDates({});
    setLiveSlots({});
    setSlotServiceByKey({});
    setSlotsLoading({});
    // Reset language tracking for the new conversation
    userLanguageRef.current = "en";
    setUserLanguage("en");
    setTranslatedQuickReplies(null);
    // Generate a fresh session ID so the new conversation is stored separately
    const newSessionId = crypto.randomUUID();
    localStorage.setItem("apollo_session_id", newSessionId);
    localStorage.removeItem("apollo_machine_snapshot");
    sessionIdRef.current = newSessionId;
    setMessages([{ id: nextId(), sender: "bot", text: getStateResponse(initial).message }]);
  }, []);

  return {
    messages,
    currentState,
    machineCtx,
    isLlmLoading,
    rateLimitSeconds,
    doctorCards,
    cardsAnchorMsgId,
    conversationSummary,
    liveDates,
    liveSlots,
    slotsLoading,
    userLanguage,
    translatedQuickReplies,
    getServiceIdForSlot,
    fetchSlotsForDate,
    selectDoctorForBooking,
    requestAppointmentForDoctor,
    sendUserText,
    sendQuickReply,
    resetMachine,
  };
}


