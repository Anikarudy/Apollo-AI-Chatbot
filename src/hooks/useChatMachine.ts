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
  "SEARCH_BY_SPECIALTY_STATE", "PROCESS_SYMPTOM_CATEGORY", "PROCESS_SYMPTOM_DETAIL",
  "MAP_TO_SPECIALTY", "BOOKING_FAILED_STATE", "RESCHEDULE_FAILED_STATE",
  "CANCEL_FAILED_STATE", "UHID_GENERATE_FAILED",
  "SHOW_DOCTORS",        // UI is card-driven; LLM message shown before cards load
  "CONFIRM_APPOINTMENT", // Dynamic context-aware message handled by stateResponses
  "BOOKING_CONFIRMED",   // Dynamic message handled by stateResponses
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
  const [slotsLoading, setSlotsLoading] = useState<Record<string, boolean>>({});

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
          doctors?: Array<{ name: string; specialty?: string; hospital?: string; profileUrl?: string; resourceId?: string }>;
        };

        const cards = (data.doctors ?? []).slice(0, 6).map((d) => ({
          name:       d.name,
          specialty:  d.specialty ?? machineCtx.specialty,
          hospital:   d.hospital  ?? hospital,
          profileUrl: d.profileUrl,
          resourceId: d.resourceId,
          locationId: undefined as string | undefined,
          regionId:   "5",
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

  // ── Load live dates for each doctor card that has a resourceId ───────────
  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS" && currentState !== "RESCHEDULE_APPOINTMENT") return;
    if (doctorCards.length === 0) return;
    setLiveDates({});

    const controller = new AbortController();
    doctorCards.forEach((doctor, idx) => {
      if (!doctor.resourceId || !doctor.locationId) return;
      const key = `${doctor.name}-${idx}`;

      fetch("/api/edoc/calendar-dates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: doctor.resourceId, locationId: doctor.locationId, regionId: doctor.regionId ?? "5" }),
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((data: unknown) => {
          const d = data as { dates?: Array<{ display: string; edoc: string }> };
          const parsed: LiveDate[] = (d.dates ?? []).slice(0, 7).map((e) => parseLiveDate(e.display));
          setLiveDates((prev) => ({ ...prev, [key]: parsed }));
        })
        .catch(() => {/* no live dates – UI falls back to static */});
    });

    return () => controller.abort();
  }, [currentState, doctorCards]);

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
      const res = await fetch("/api/edoc/slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId, locationId, regionId, date: edocDate }),
      });
      const data = (await res.json()) as { slots?: string[] };
      setLiveSlots((prev) => ({ ...prev, [cacheKey]: data.slots ?? [] }));
    } catch {
      setLiveSlots((prev) => ({ ...prev, [cacheKey]: [] }));
    } finally {
      setSlotsLoading((prev) => ({ ...prev, [cacheKey]: false }));
    }
  }, [liveSlots]);

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

    fetch("/api/edoc/generate-uhid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        RegistrationTypes: "FreeUHID",
        Title: "1",
        LocationID: locationId ?? "10551",
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
    const { resourceId, locationId, regionId, serviceId, uhid, selectedDate, selectedSlotStart, selectedSlotEnd, phoneNumber, doctorName, specialty } = machineCtx;
    if (!resourceId || !locationId || !selectedDate || !selectedSlotStart || !uhid) {
      sendSilentEvent("BOOKING_FAILED");
      return;
    }
    const startDT = `${selectedDate} ${selectedSlotStart}:00`;
    const endDT   = `${selectedDate} ${selectedSlotEnd ?? addFifteenMin(selectedSlotStart)}:00`;

    fetch("/api/edoc/book-appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        RegistrationType: "QuickUHID",
        LocationID: locationId,
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
        StartDateTime: startDT,
        EndDateTime: endDT,
        InternationalPatientFlag: false,
        logID: crypto.randomUUID(),
        ModeofAppointment: "Apollo Assist Web",
      }),
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { AppointmentID?: string | number; retcode?: number };
        if (d.AppointmentID !== undefined && d.retcode === 0) {
          sendSilentEvent("BOOKING_DONE", String(d.AppointmentID));
        } else {
          sendSilentEvent("BOOKING_FAILED");
        }
      })
      .catch(() => sendSilentEvent("BOOKING_FAILED"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState]);

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
    const startDT = `${selectedDate} ${selectedSlotStart}:00`;
    const endDT   = `${selectedDate} ${selectedSlotEnd ?? addFifteenMin(selectedSlotStart)}:00`;

    fetch("/api/edoc/reschedule-appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        AppointmentID: Number(appointmentId),
        LocationID: locationId ?? "10551",
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

    fetch("/api/edoc/cancel-appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        LocationID: locationId ?? "10551",
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
      const { allCities: cities, specialities } = await import("../knowledgeBase.js");
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
      // Only auto-navigate if we have a clear booking/find intent AND at least specialty or city
      const isActionable = (parsed.intent === "book_appointment" || parsed.intent === "find_doctor")
        && (parsed.specialty || parsed.city || parsed.doctorName);
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
    (doctor: DoctorCardData, edocDate: string, startTime: string) => {
      const endTime = addFifteenMin(startTime);
      const payload = JSON.stringify({
        date:       edocDate,
        startTime,
        endTime,
        resourceId: doctor.resourceId,
        locationId: doctor.locationId,
        regionId:   doctor.regionId ?? "5",
        serviceId:  doctor.serviceId,
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
    fetchSlotsForDate,
    selectDoctorForBooking,
    sendUserText,
    sendQuickReply,
    resetMachine,
  };
}


