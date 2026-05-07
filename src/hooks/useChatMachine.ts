/**
 * useChatMachine.ts
 * React hook that wraps the XState ApolloAssistRunner.
 * Exposes messages, currentState, and action functions to the UI.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ApolloAssistRunner } from "../../apolloAssistMachine";
import { mapInputToEvent, AppEvent } from "../inputMapping.js";
import { getStateResponse, ChatContext } from "../stateResponses";

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
]);

// States where free-text should first be sent to the AI intent parser.
const AI_NAV_STATES = [
  "WELCOME", "MAIN_MENU", "FALLBACK",
  "BOOK_APPT_OPTIONS", "BOOK_APPT_OPTIONS_LOCATION",
  "FIND_DOCTOR_OPTIONS",
];

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

export function useChatMachine() {
  const runnerRef = useRef<ApolloAssistRunner | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Keep ref in sync with state so callbacks can read current messages without dep issues
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [currentState, setCurrentState] = useState<string>("WELCOME");
  const [machineCtx, setMachineCtx] = useState<ChatContext>({});
  const [isLlmLoading, setIsLlmLoading] = useState(false);
  const [doctorCards, setDoctorCards] = useState<DoctorCardData[]>([]);
  // ID of the bot message after which doctor cards should be rendered inline
  const [cardsAnchorMsgId, setCardsAnchorMsgId] = useState<string | null>(null);

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

  // Initialize runner once
  useEffect(() => {
    const runner = new ApolloAssistRunner();
    runnerRef.current = runner;
    const initial = runner.currentState;
    setCurrentState(initial);
    const welcome = getStateResponse(initial);
    setMessages([{ id: nextId(), sender: "bot", text: welcome.message }]);
    return () => runner.stop();
  }, []);

  // Static response
  const pushStaticBotMessage = useCallback((state: string, ctx: ChatContext) => {
    const resp = getStateResponse(state, ctx);
    setMessages((prev) => [...prev, { id: nextId(), sender: "bot", text: resp.message }]);
  }, []);

  const logEdoc = useCallback((step: string, payload: Record<string, unknown>) => {
    // Keep logs verbose by design for EDOC diagnostics.
    console.info(`[EDOC] ${step}`, payload);
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
    logEdoc("BookAppointment.request", payload);
    const res = await fetch("/api/edoc/book-appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

        const cards = (data.doctors ?? []).slice(0, 6).map((d) => ({
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
        } else {
          // No doctors found — show a single "no results" placeholder
          setDoctorCards([{ name: "No doctors found", specialty: machineCtx.specialty, hospital: "Try a different search or visit apollohospitals.com" }]);
        }
        setCardsAnchorMsgId(anchorId);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentState: state, context: ctx, userMessage, history }),
      });
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

  // ── Free-text input ────────────────────────────────────────────────────────
  const sendUserText = useCallback(
    async (text: string) => {
      const runner = runnerRef.current;
      if (!runner) return;
      setMessages((prev) => [...prev, { id: nextId(), sender: "user", text }]);

      // In SHOW_DOCTORS, handle text without leaving the cards view.
      if (currentState === "SHOW_DOCTORS") {
        const event = mapInputToEvent(text, currentState);
        if (event.type !== "UNKNOWN") {
          // Explicit keyword navigation (CHANGE_SEARCH / BACK_TO_MENU)
          runner.sendEvent(event);
          const nextState = runner.currentState;
          const nextCtx = runner.context as ChatContext;
          if (nextState !== edocFiredForState.current) edocFiredForState.current = "";
          setCurrentState(nextState);
          setMachineCtx(nextCtx);
          await pushLlmBotMessage(nextState, nextCtx as Record<string, unknown>, text);
        } else {
          // Try AI intent navigation first (catches "wrong specialty", "different city", etc.)
          const navigated = await tryAiIntent(text);
          if (!navigated) {
            // Purely conversational — respond in-place without leaving SHOW_DOCTORS
            await pushLlmDirect(currentState, runner.context as Record<string, unknown>, text);
          }
        }
        return;
      }

      // For navigation states, first try AI intent parsing
      if (AI_NAV_STATES.includes(currentState)) {
        const navigated = await tryAiIntent(text);
        if (navigated) return; // AI handled it — skip normal event mapping

        // Deterministic fallback: if input looks like a person-name query,
        // route into the doctor-name state-machine flow even when intent parser misses it.
        const looksLikeNameOnlyQuery = /^[A-Za-z][A-Za-z\s.']{2,}$/.test(text)
          && text.trim().split(/\s+/).length >= 2
          && !/\b(book|appointment|doctor|specialty|symptom|pain|fever|city|branch|hospital)\b/i.test(text);
        if (looksLikeNameOnlyQuery) {
          const payload = JSON.stringify({ doctorName: text.trim() });
          runner.sendEvent({ type: "AI_PREFILL", value: payload } as AppEvent);
          const nextState = runner.currentState;
          const nextCtx = runner.context as ChatContext;
          if (nextState !== edocFiredForState.current) {
            edocFiredForState.current = "";
          }
          setCurrentState(nextState);
          setMachineCtx(nextCtx);
          pushStaticBotMessage(nextState, nextCtx);
          return;
        }
      }

      const event = mapInputToEvent(text, currentState);
      runner.sendEvent(event);
      const nextState = runner.currentState;
      const nextCtx = runner.context as ChatContext;
      // Reset EDOC fire guard when state changes (same as sendEvent / sendSilentEvent)
      if (nextState !== edocFiredForState.current) {
        edocFiredForState.current = "";
      }
      setCurrentState(nextState);
      setMachineCtx(nextCtx);
      await pushLlmBotMessage(nextState, runner.context as Record<string, unknown>, text);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentState, pushLlmBotMessage, pushLlmDirect, tryAiIntent]
  );

  const sendQuickReply = useCallback(
    (label: string, eventType: string, value?: string) => {
      setMessages((prev) => [...prev, { id: nextId(), sender: "user", text: label }]);
      sendEvent(eventType, value);
    },
    [sendEvent]
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
      sendEvent("SELECT_SLOT", payload);
    },
    [sendEvent]
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
      sendEvent("SELECT_SLOT", payload);
    },
    [sendEvent]
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
    setLiveDates({});
    setLiveSlots({});
    setSlotServiceByKey({});
    setSlotsLoading({});
    setMessages([{ id: nextId(), sender: "bot", text: getStateResponse(initial).message }]);
  }, []);

  return {
    messages,
    currentState,
    machineCtx,
    isLlmLoading,
    doctorCards,
    cardsAnchorMsgId,
    liveDates,
    liveSlots,
    slotsLoading,
    getServiceIdForSlot,
    fetchSlotsForDate,
    selectDoctorForBooking,
    requestAppointmentForDoctor,
    sendUserText,
    sendQuickReply,
    resetMachine,
  };
}


