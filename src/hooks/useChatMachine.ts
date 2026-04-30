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

interface DoctorLocationsResponse {
  locations?: Array<{ locationId: string; locationName: string }>;
  retcode?: number;
  message?: string | null;
  error?: string;
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
  "SEARCH_BY_SPECIALTY_STATE", "PROCESS_SYMPTOM_CATEGORY", "PROCESS_SYMPTOM_DETAIL",
  "MAP_TO_SPECIALTY", "BOOKING_FAILED_STATE", "RESCHEDULE_FAILED_STATE",
  "CANCEL_FAILED_STATE", "UHID_GENERATE_FAILED",
  "SELECT_DOCTOR", "FETCH_DOCTOR_LOCATIONS", "FETCH_LIVE_DATES", "FETCH_SLOTS",
  "DOCTOR_LOCATIONS_FAILED_STATE", "LIVE_DATES_FAILED_STATE", "SLOTS_FAILED_STATE",
  "DOCTOR_NAME_SUGGESTIONS", // rendered by stateResponses with suggestion buttons
  "AI_PREFILL_ROUTE",        // transient routing state, never shown
  "SHOW_DOCTORS",            // UI is card-driven; LLM message shown before cards load
  "CONFIRM_APPOINTMENT",     // Dynamic context-aware message handled by stateResponses
  "BOOKING_CONFIRMED",       // Dynamic message handled by stateResponses
]);

// States where free-text should first be sent to the AI intent parser.
const AI_NAV_STATES = ["WELCOME", "MAIN_MENU", "FALLBACK"];

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

function getSafeLocationId(locationId?: string): string | undefined {
  return isValidLocationId(locationId) ? String(locationId).trim() : undefined;
}

function parseMachinePayload(value?: string): Record<string, string> {
  try {
    return JSON.parse(value ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function useChatMachine() {
  const runnerRef = useRef<ApolloAssistRunner | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentState, setCurrentState] = useState<string>("WELCOME");
  const [machineCtx, setMachineCtx] = useState<ChatContext>({});
  const [isLlmLoading, setIsLlmLoading] = useState(false);
  const [doctorCards, setDoctorCards] = useState<DoctorCardData[]>([]);

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

  const getDoctorLocations = useCallback(async (
    params: {
      resourceId: string;
      regionId: string;
      signal?: AbortSignal;
    }
  ): Promise<DoctorLocationsResponse> => {
    logEdoc("DoctorLocations.request", {
      resourceId: params.resourceId,
      regionId: params.regionId,
    });
    const res = await fetch("/api/doctor/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: params.resourceId,
        regionId: params.regionId,
      }),
      signal: params.signal,
    });
    const data = (await res.json()) as DoctorLocationsResponse;
    logEdoc("DoctorLocations.response", {
      status: res.status,
      locationsCount: (data.locations ?? []).length,
      retcode: data.retcode ?? null,
      error: data.error ?? null,
    });
    if (!res.ok) {
      throw new Error(String(data.error ?? "Doctor locations lookup failed"));
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
      if (currentState !== "SHOW_DOCTORS") setDoctorCards([]);
      return;
    }
    if (currentState === "RESCHEDULE_APPOINTMENT") return; // keep existing cards

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

        if (cards.length > 0) {
          setDoctorCards(cards);
        } else {
          // No doctors found — show a single "no results" placeholder
          setDoctorCards([{ name: "No doctors found", specialty: machineCtx.specialty, hospital: "Try a different search or visit apollohospitals.com" }]);
        }
      } catch {
        setDoctorCards([{ name: fallbackName, specialty: machineCtx.specialty, hospital }]);
      }
    };

    void loadDoctors();
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx.branch, machineCtx.city, machineCtx.doctorName, machineCtx.specialty]);

  // ── Load live dates for each doctor card by resolving locationId first ───
  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS" && currentState !== "RESCHEDULE_APPOINTMENT") return;
    if (doctorCards.length === 0) return;

    const scheduleCards = doctorCards
      .map((doctor, idx) => ({ doctor, idx }))
      .filter(({ doctor }) => !!doctor.resourceId || (doctor.resourceIds?.length ?? 0) > 0)
      .map(({ doctor, idx }) => {
        const stableCandidates = Array.from(new Set(
          [doctor.resourceId, ...(doctor.resourceIds ?? [])]
            .map((value) => String(value ?? "").trim())
            .filter((value): value is string => value.length > 0)
        )).sort();
        return `${doctor.name}-${idx}|${doctor.regionId ?? "5"}|${stableCandidates.join(",")}|${machineCtx.city ?? ""}`;
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
      const key = `${doctor.name}-${idx}`;
      const resourceCandidates = Array.from(new Set(
        [doctor.resourceId, ...(doctor.resourceIds ?? [])]
          .map((value) => String(value ?? "").trim())
          .filter((value): value is string => value.length > 0)
      ));
      if (resourceCandidates.length === 0) return;

      const stableCandidates = [...resourceCandidates].sort();
      const requestKey = `${stableCandidates.join(",")}|${doctor.regionId ?? "5"}|${machineCtx.city ?? ""}`;
      if (liveDateRequestsInFlight.current.has(requestKey) || liveDateRequestsDone.current.has(requestKey)) return;
      liveDateRequestsInFlight.current.add(requestKey);

      const loadLiveSchedule = async () => {
        try {
          let selectedResourceId: string | undefined;
          let selectedLocationId: string | undefined;
          let selectedDatesResponse: AvailableDatesResponse | undefined;

          for (const candidateResourceId of resourceCandidates) {
            try {
              const locationResponse = await getDoctorLocations({
                resourceId: candidateResourceId,
                regionId: doctor.regionId ?? "5",
                signal: controller.signal,
              });

              const locationCandidates = (locationResponse.locations ?? [])
                .map((location) => String(location.locationId ?? "").trim())
                .filter((locationId): locationId is string => isValidLocationId(locationId));
              if (locationCandidates.length === 0) continue;

              const preferredLocation = locationCandidates.includes(String(doctor.locationId ?? "").trim())
                ? String(doctor.locationId ?? "").trim()
                : locationCandidates[0];

              const d = await getAvailableDates({
                resourceId: candidateResourceId,
                locationId: preferredLocation,
                regionId: doctor.regionId ?? "5",
                city: machineCtx.city,
                signal: controller.signal,
              });
              if ((d.dates ?? []).length > 0) {
                selectedResourceId = candidateResourceId;
                selectedLocationId = d.locationId ?? preferredLocation;
                selectedDatesResponse = d;
                break;
              }
              if (!selectedDatesResponse) {
                selectedDatesResponse = d;
                selectedLocationId = d.locationId ?? preferredLocation;
              }
            } catch {
              // Try next candidate resource ID.
            }
          }

          const parsed: LiveDate[] = (selectedDatesResponse?.dates ?? []).slice(0, 7).map((e) => parseLiveDate(e.display));
          setLiveDates((prev) => ({ ...prev, [key]: parsed }));

          const effectiveResourceId = selectedResourceId ?? resourceCandidates[0];
          const resolvedLocationId = selectedLocationId ?? (isValidLocationId(doctor.locationId) ? String(doctor.locationId).trim() : undefined);

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

          if (resolvedLocationId && resolvedLocationId !== doctor.locationId) {
            setDoctorCards((prev) =>
              {
                let changed = false;
                const next = prev.map((card, cardIdx) => {
                  if (cardIdx !== idx) return card;
                  if (card.locationId === resolvedLocationId) return card;
                  changed = true;
                  return { ...card, locationId: resolvedLocationId };
                });
                return changed ? next : prev;
              }
            );
          }

          // Auto-load slots for the first available date so live slot API is used immediately.
          const firstDate = parsed[0];
          if (!firstDate || !resolvedLocationId) return;
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
  }, [currentState, doctorCards, machineCtx.city, getAvailableDates, getCalendarDetails, getDoctorLocations, getSlots, getSlotsV2]);

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
      .filter(({ doctor }) => !!doctor.resourceId || (doctor.resourceIds?.length ?? 0) > 0);
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

  // FETCH_DOCTOR_LOCATIONS: resolve a numeric locationId for selected doctor
  useEffect(() => {
    if (currentState !== "FETCH_DOCTOR_LOCATIONS") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;

    const payload = parseMachinePayload(machineCtx.pendingSlotSelection);
    const resourceId = String(machineCtx.resourceId ?? payload.resourceId ?? "").trim();
    const regionId = String(machineCtx.regionId ?? payload.regionId ?? "5").trim() || "5";
    const preferredLocationId = String(machineCtx.locationId ?? payload.locationId ?? "").trim();

    if (!resourceId) {
      sendSilentEvent("DOCTOR_LOCATIONS_FAILED", JSON.stringify({ error: "Selected doctor details are incomplete." }));
      return;
    }

    const runFetchDoctorLocations = async () => {
      try {
        const response = await getDoctorLocations({ resourceId, regionId });
        const locationIds = (response.locations ?? [])
          .map((location) => String(location.locationId ?? "").trim())
          .filter((locationId): locationId is string => isValidLocationId(locationId));

        if (locationIds.length === 0) {
          sendSilentEvent("DOCTOR_LOCATIONS_FAILED", JSON.stringify({ error: "No locations found for this doctor." }));
          return;
        }

        const resolvedLocationId = locationIds.includes(preferredLocationId)
          ? preferredLocationId
          : locationIds[0];
        sendSilentEvent("DOCTOR_LOCATIONS_FETCHED", JSON.stringify({ locationId: resolvedLocationId, regionId }));
      } catch (err: unknown) {
        sendSilentEvent(
          "DOCTOR_LOCATIONS_FAILED",
          JSON.stringify({ error: String((err as { message?: string })?.message ?? "Unable to fetch doctor locations right now.") })
        );
      }
    };

    void runFetchDoctorLocations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx.locationId, machineCtx.pendingSlotSelection, machineCtx.regionId, machineCtx.resourceId, getDoctorLocations]);

  // FETCH_LIVE_DATES: load available dates only after locationId is resolved
  useEffect(() => {
    if (currentState !== "FETCH_LIVE_DATES") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;

    const payload = parseMachinePayload(machineCtx.pendingSlotSelection);
    const resourceId = String(machineCtx.resourceId ?? payload.resourceId ?? "").trim();
    const regionId = String(machineCtx.regionId ?? payload.regionId ?? "5").trim() || "5";
    const locationId = String(machineCtx.locationId ?? payload.locationId ?? "").trim();
    const requestedDate = String(machineCtx.selectedDate ?? payload.date ?? "").trim();

    if (!resourceId || !isValidLocationId(locationId)) {
      sendSilentEvent("LIVE_DATES_FAILED", JSON.stringify({ error: "Unable to fetch live dates without a valid location." }));
      return;
    }

    const runFetchLiveDates = async () => {
      try {
        const response = await getAvailableDates({
          resourceId,
          locationId,
          regionId,
          city: machineCtx.city,
        });
        const dates = response.dates ?? [];
        if (dates.length === 0) {
          sendSilentEvent("LIVE_DATES_FAILED", JSON.stringify({ error: "No live dates are available for this doctor." }));
          return;
        }

        const selectedDate = dates.some((date) => date.edoc === requestedDate)
          ? requestedDate
          : dates[0].edoc;
        sendSilentEvent("LIVE_DATES_FETCHED", JSON.stringify({
          selectedDate,
          locationId: response.locationId ?? locationId,
        }));
      } catch (err: unknown) {
        sendSilentEvent(
          "LIVE_DATES_FAILED",
          JSON.stringify({ error: String((err as { message?: string })?.message ?? "Unable to fetch live dates right now.") })
        );
      }
    };

    void runFetchLiveDates();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx.city, machineCtx.locationId, machineCtx.pendingSlotSelection, machineCtx.regionId, machineCtx.resourceId, machineCtx.selectedDate, getAvailableDates]);

  // FETCH_SLOTS: load slots only after locationId and date are available
  useEffect(() => {
    if (currentState !== "FETCH_SLOTS") return;
    if (edocFiredForState.current === currentState) return;
    edocFiredForState.current = currentState;

    const payload = parseMachinePayload(machineCtx.pendingSlotSelection);
    const resourceId = String(machineCtx.resourceId ?? payload.resourceId ?? "").trim();
    const regionId = String(machineCtx.regionId ?? payload.regionId ?? "5").trim() || "5";
    const locationId = String(machineCtx.locationId ?? payload.locationId ?? "").trim();
    const selectedDate = String(machineCtx.selectedDate ?? payload.date ?? "").trim();
    const selectedSlotStart = String(machineCtx.selectedSlotStart ?? payload.startTime ?? "").trim();

    if (!resourceId || !isValidLocationId(locationId) || !selectedDate) {
      sendSilentEvent("SLOTS_FAILED", JSON.stringify({ error: "Unable to fetch slots without doctor location and date." }));
      return;
    }

    const runFetchSlots = async () => {
      try {
        try {
          await getCalendarDetails({
            resourceId,
            locationId,
            regionId,
            date: selectedDate,
            city: machineCtx.city,
          });
        } catch {
          // Keep booking flow alive even if sync-calendar endpoint fails.
        }

        let slotList: string[] = [];
        let defaultServiceId: string | undefined;
        const slotToService: Record<string, string> = {};

        try {
          const slotsV2 = await getSlotsV2({
            resourceId,
            locationId,
            regionId,
            date: selectedDate,
            city: machineCtx.city,
          });
          slotList = slotsV2.allSlots ?? [];
          defaultServiceId = slotsV2.defaultServiceId ?? undefined;
          Object.assign(slotToService, slotsV2.slotToServiceId ?? {});
        } catch {
          slotList = [];
        }

        if (slotList.length === 0) {
          const fallbackSlots = await getSlots({
            resourceId,
            locationId,
            regionId,
            date: selectedDate,
            city: machineCtx.city,
          });
          slotList = fallbackSlots.slots ?? [];
        }

        if (slotList.length === 0) {
          sendSilentEvent("SLOTS_FAILED", JSON.stringify({ error: "No slots are available for this date." }));
          return;
        }

        if (!selectedSlotStart || !slotList.includes(selectedSlotStart)) {
          sendSilentEvent("SLOTS_FAILED", JSON.stringify({ error: "The selected slot is no longer available. Please choose another slot." }));
          return;
        }

        const resolvedServiceId = slotToService[selectedSlotStart] ?? machineCtx.serviceId ?? defaultServiceId;
        sendSilentEvent("SLOTS_FETCHED", JSON.stringify({ serviceId: resolvedServiceId ?? "" }));
      } catch (err: unknown) {
        sendSilentEvent(
          "SLOTS_FAILED",
          JSON.stringify({ error: String((err as { message?: string })?.message ?? "Unable to fetch slots right now.") })
        );
      }
    };

    void runFetchSlots();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, machineCtx.city, machineCtx.locationId, machineCtx.pendingSlotSelection, machineCtx.regionId, machineCtx.resourceId, machineCtx.selectedDate, machineCtx.selectedSlotStart, machineCtx.serviceId, getCalendarDetails, getSlots, getSlotsV2]);

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
    if (!safeLocationId) { sendSilentEvent("UHID_FAILED"); return; }

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
        DateOfBirth: patientDob ?? "01-Jan-1990",
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
    if (!resourceId || !selectedDate || !selectedSlotStart || !uhid) {
      sendSilentEvent("BOOKING_FAILED");
      return;
    }
    const safeLocationId = getSafeLocationId(locationId);
    if (!safeLocationId) {
      sendSilentEvent("BOOKING_FAILED");
      return;
    }

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
    if (!safeLocationId) {
      sendSilentEvent("RESCHEDULE_FAILED");
      return;
    }
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
    if (!safeLocationId) {
      sendSilentEvent("CANCEL_FAILED");
      return;
    }

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
    try {
      setIsLlmLoading(true);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentState: state, context: ctx, userMessage }),
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

  // ── AI: parse intent and auto-navigate (WELCOME / MAIN_MENU / FALLBACK) ──
  const tryAiIntent = useCallback(async (text: string): Promise<boolean> => {
    const runner = runnerRef.current;
    if (!runner) return false;
    try {
      const { allCities: cities, specialities } = await import("../knowledgeBase");
      const res = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, cities, specialties: specialities }),
      });
      if (!res.ok) return false;
      const parsed = await res.json() as {
        intent: string;
        specialty?: string | null;
        city?: string | null;
        branch?: string | null;
        doctorName?: string | null;
      };
      // Only auto-navigate if we have a clear booking/find intent AND at least specialty or doctorName
      const isActionable = (parsed.intent === "book_appointment" || parsed.intent === "find_doctor")
        && (parsed.specialty || parsed.doctorName);
      if (!isActionable) return false;

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
  }, [pushStaticBotMessage]);

  // ── Free-text input ────────────────────────────────────────────────────────
  const sendUserText = useCallback(
    async (text: string) => {
      const runner = runnerRef.current;
      if (!runner) return;
      setMessages((prev) => [...prev, { id: nextId(), sender: "user", text }]);

      // For navigation states, first try AI intent parsing
      if (AI_NAV_STATES.includes(currentState)) {
        const navigated = await tryAiIntent(text);
        if (navigated) return; // AI handled it — skip normal event mapping
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
    [currentState, pushLlmBotMessage, tryAiIntent]
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
      });
      setMessages((prev) => [
        ...prev,
        { id: nextId(), sender: "user", text: `Book ${doctor.name} · ${edocDate} at ${startTime}` },
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
    liveDates,
    liveSlots,
    slotsLoading,
    getServiceIdForSlot,
    fetchSlotsForDate,
    selectDoctorForBooking,
    sendUserText,
    sendQuickReply,
    resetMachine,
  };
}


