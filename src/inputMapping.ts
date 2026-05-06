/**
 * inputMapping.ts
 * Converts raw user text into typed XState machine events.
 *
 * Separated from apolloAssistMachine.ts for:
 * - Better modularity and testability
 * - Easier to maintain keyword detection logic
 * - Can be unit tested independently
 */

import { allCities } from "./knowledgeBase";

// ─────────────────────────────────────────────────────────────
// EVENT TYPES
// ─────────────────────────────────────────────────────────────

export type AppEvent =
  | { type: "START" }
  | { type: "BOOK_APPOINTMENT" }
  | { type: "FIND_DOCTOR" }
  | { type: "HEALTH_CHECKUP" }
  | { type: "INTERNATIONAL_SERVICES" }
  | { type: "EMERGENCY" }
  | { type: "KNOW_DOCTOR_NAME" }
  | { type: "FIND_BY_SPECIALTY" }
  | { type: "HAVE_SYMPTOMS" }
  | { type: "BOOK_BY_LOCATION" }
  | { type: "ENTER_NAME"; value: string }
  | { type: "ENTER_SYMPTOM"; value: string }
  | { type: "SELECT_SPECIALTY"; value: string }
  | { type: "ENTER_SPECIALTY"; value: string }
  | { type: "SELECT_CATEGORY"; value: string }
  | { type: "ENTER_SYMPTOM_TEXT"; value: string }
  | { type: "SELECT_DETAIL"; value: string }
  | { type: "AUTO" }
  | { type: "ENTER_CITY"; value: string }
  | { type: "SELECT_CITY"; value: string }
  | { type: "SELECT_BRANCH"; value: string }
  | { type: "SELECT_DOCTOR"; value: string }
  | { type: "FOUND" }
  | { type: "NOT_FOUND" }
  | { type: "SELECT_SLOT"; value?: string }  // value = JSON {date,startTime,endTime,resourceId,locationId,regionId,serviceId}
  | { type: "CHANGE_SEARCH" }
  | { type: "CHANGE_SPECIALTY" }
  | { type: "RETRY_NAME" }
  | { type: "RETRY_SPECIALTY" }
  | { type: "SEARCH_BY_SPECIALTY" }
  | { type: "CHANGE_CITY" }
  | { type: "CONTINUE" }
  | { type: "ENTER_PHONE"; value: string }
  | { type: "EXIT_VERIFICATION" }
  | { type: "OTP_SUCCESS" }
  | { type: "DONE" }
  | { type: "BY_SPECIALTY" }
  | { type: "BY_DOCTOR_NAME" }
  | { type: "BY_SYMPTOMS" }
  | { type: "VIEW_PACKAGE_DETAILS"; value?: string }
  | { type: "ASK_TO_BOOK" }
  | { type: "EXIT" }
  | { type: "CALL" }
  | { type: "ENTER_PARTIAL_DETAILS" }
  | { type: "ENTER_ALL_DETAILS" }
  | { type: "REFUSE_DETAIL" }
  | { type: "MISSING_FIELDS" }
  | { type: "ALL_FIELDS_PRESENT" }
  | { type: "PROVIDE_DETAIL" }
  | { type: "SHOW_CONTACT_OPTION" }
  | { type: "CONFIRM" }
  | { type: "EDIT_DETAILS" }
  | { type: "CANCEL" }
  | { type: "SUCCESS" }
  | { type: "CALL_EMERGENCY" }
  | { type: "END_CONVERSATION" }
  | { type: "RETRY" }
  | { type: "BACK_TO_MENU" }
  // ── EDOC real-booking events ─────────────────────────────────────────────
  | { type: "UHID_FOUND"; value: string }
  | { type: "UHID_NOT_FOUND" }
  | { type: "UHID_GENERATED"; value: string }
  | { type: "UHID_FAILED" }
  | { type: "BOOKING_DONE"; value: string }
  | { type: "BOOKING_FAILED" }
  | { type: "CONFIRM_BOOKING_REAL" }
  | { type: "RESCHEDULE" }
  | { type: "RESCHEDULE_DONE"; value: string }
  | { type: "RESCHEDULE_FAILED" }
  | { type: "CANCEL_BOOKING" }
  | { type: "CONFIRM_CANCEL" }
  | { type: "CANCEL_DONE" }
  | { type: "CANCEL_FAILED" }
  | { type: "SKIP_UHID" }
  | { type: "RETRY_PATIENT_DETAILS" }
  | { type: "ENTER_PATIENT_DETAILS"; value: string }
  // ── AI intent navigation ──────────────────────────────────────────────────
  | { type: "AI_PREFILL"; value: string }   // JSON: {specialty?,city?,branch?,doctorName?}
  | { type: "AI_SYMPTOM_MAPPED"; value: string } // specialty string from AI
  | { type: "UNKNOWN" };

// ─────────────────────────────────────────────────────────────
// INPUT MAPPING FUNCTION
// ─────────────────────────────────────────────────────────────

/**
 * mapInputToEvent
 * Converts a raw user text string into a typed AppEvent.
 * Uses keyword detection and state-aware heuristics.
 *
 * @param message - Raw user input text
 * @param currentState - Optional: current XState machine state (helps with context-aware mapping)
 * @returns Typed AppEvent ready to send to the state machine
 */
export function mapInputToEvent(message: string, currentState?: string): AppEvent {
  const text = message.toLowerCase().trim();
  const state = (currentState ?? "").toUpperCase();

  if (!text) return { type: "UNKNOWN" };

  // ── State-aware free-text mapping (highest priority) ─────
  // This prevents generic parsing from misclassifying inputs like city names as doctor names.
  if (state === "ENTER_DOCTOR_NAME") {
    return { type: "ENTER_NAME", value: message.trim() };
  }

  if (state === "SELECT_SPECIALTY") {
    return { type: "ENTER_SPECIALTY", value: message.trim() };
  }

  if (state === "ASK_BASIC_DETAILS") {
    return { type: "ENTER_SYMPTOM", value: message.trim() };
  }

  if (state === "ASK_CITY" || state === "HEALTH_CHECKUP_ENTRY" || state === "ASK_CITY_FOR_LOCATION" || state === "DOCTOR_NOT_FOUND_ASK_CITY") {
    const cityMatch = allCities.find((city) => {
      const lower = city.toLowerCase();
      return lower === text || lower.includes(text) || text.includes(lower);
    });
    return { type: "ENTER_CITY", value: cityMatch ?? message.trim() };
  }

  if (state === "ASK_BRANCH" || state === "ASK_BRANCH_FOR_LOCATION") {
    return { type: "SELECT_BRANCH", value: message.trim() };
  }

  if (state === "DOCTOR_NAME_SUGGESTIONS") {
    if (/(specialty|speciality|specialist|department)/i.test(text)) return { type: "SEARCH_BY_SPECIALTY" };
    return { type: "SELECT_DOCTOR", value: message.trim() };
  }

  if (state === "BOOK_APPT_OPTIONS" || state === "BOOK_APPT_OPTIONS_LOCATION") {
    if (/(name|doctor name|know doctor)/i.test(text)) return { type: "KNOW_DOCTOR_NAME" };
    if (/(specialty|speciality|specialist|department)/i.test(text)) return { type: "FIND_BY_SPECIALTY" };
    if (/(symptom|symptoms|pain|issue|problem)/i.test(text)) return { type: "HAVE_SYMPTOMS" };
    if (/(health check|checkup|package|preventive)/i.test(text)) return { type: "HEALTH_CHECKUP" };
  }

  if (state === "FIND_DOCTOR_OPTIONS") {
    if (/(specialty|speciality|specialist|department)/i.test(text)) return { type: "BY_SPECIALTY" };
    if (/(name|doctor name|know doctor)/i.test(text)) return { type: "BY_DOCTOR_NAME" };
    if (/(symptom|symptoms|pain|issue|problem)/i.test(text)) return { type: "BY_SYMPTOMS" };
  }

  if (state === "ENTER_PHONE" || state === "ENTER_PHONE_FOR_BOOKING") {
    const phone = message.replace(/[^0-9+]/g, "");
    if (/^\+?[0-9]{10,13}$/.test(phone)) {
      return { type: "ENTER_PHONE", value: phone };
    }
  }

  if (state === "VERIFY_OTP" && /^\d{4,8}$/.test(text)) {
    return { type: "OTP_SUCCESS" };
  }

  if (state === "ASK_DETAILS") {
    return { type: "ENTER_PARTIAL_DETAILS" };
  }

  if (state === "ASK_SPECIFIC_DETAIL") {
    return { type: "PROVIDE_DETAIL" };
  }

  if (state === "COLLECT_PATIENT_DETAILS") {
    return { type: "ENTER_PATIENT_DETAILS", value: message.trim() };
  }

  // In SHOW_DOCTORS, typing "book" / "I want to book" maps to Change Search so the
  // AI layer can handle the intent via tryAiIntent (SHOW_DOCTORS is in AI_NAV_STATES)
  if (state === "SHOW_DOCTORS") {
    if (/(change|search|different|another|new search|more doctor|wrong|not right|other doctor|different specialty|change specialty)/i.test(text)) return { type: "CHANGE_SEARCH" };
    if (/(back|menu|home|start over)/i.test(text)) return { type: "BACK_TO_MENU" };
    // Everything else falls through to UNKNOWN — handled by tryAiIntent then in-place LLM
  }

  // ── Greetings / Start ──────────────────────────────────────
  const greetings = ["hi", "hello", "hey", "start", "begin", "help"];
  if (greetings.some((k) => text.includes(k))) return { type: "START" };

  // ── Emergency ─────────────────────────────────────────────
  const emergency = [
    "emergency",
    "ambulance",
    "urgent",
    "critical",
    "heart attack",
    "stroke",
    "unconscious",
    "not breathing",
  ];
  if (emergency.some((k) => text.includes(k))) return { type: "EMERGENCY" };

  // ── Find doctor ───────────────────────────────────────────
  const findDoc = [
    "find doctor",
    "find a doctor",
    "search doctor",
    "look for doctor",
    "doctor list",
  ];
  if (findDoc.some((k) => text.includes(k))) return { type: "FIND_DOCTOR" };

  // ── Health checkup / packages (check BEFORE "book") ────────
  const checkup = [
    "health checkup",
    "health check",
    "health package",
    "lab test",
    "screening",
    "full body",
    "diagnostic",
    "blood test",
  ];
  if (checkup.some((k) => text.includes(k)))
    return { type: "HEALTH_CHECKUP" };

  // ── Book appointment ──────────────────────────────────────
  const bookAppt = [
    "book",
    "appointment",
    "schedule",
    "consultation",
    "consult",
    "need a doctor",
    "want a doctor",
    "see a doctor",
    "meet doctor",
    "get appointment",
  ];
  if (bookAppt.some((k) => text.includes(k)))
    return { type: "BOOK_APPOINTMENT" };

  // ── International patients ────────────────────────────────
  const intl = [
    "international",
    "travelling",
    "traveling",
    "visa",
    "medical tourism",
    "foreign patient",
    "coming from abroad",
  ];
  if (intl.some((k) => text.includes(k)))
    return { type: "INTERNATIONAL_SERVICES" };

  // ── Symptom input ─────────────────────────────────────────
  // Must come BEFORE doctor-name check (avoids "Dr" false-pos on "I have fever")
  const symptomPhrases = [
    "i have",
    "i feel",
    "i am feeling",
    "suffering from",
    "experiencing",
    "symptom",
    "pain",
    "fever",
    "cough",
    "headache",
    "chest",
    "stomach",
    "nausea",
    "vomiting",
    "dizziness",
    "shortness of breath",
    "fatigue",
    "rash",
    "swelling",
  ];
  if (symptomPhrases.some((k) => text.includes(k)))
    return { type: "ENTER_SYMPTOM", value: message };

  // ── Doctor name (global only for explicit Dr prefix) ─
  // Name-like free text is handled by ENTER_DOCTOR_NAME state above.
  const isDrTitle = /\bdr\.?\s+/i.test(message);
  if (isDrTitle) return { type: "ENTER_NAME", value: message };

  // ── Specialty keywords ────────────────────────────────────
  const specialties = [
    "cardiology",
    "cardiologist",
    "neurology",
    "neurologist",
    "orthopedic",
    "ortho",
    "dermatology",
    "dermatologist",
    "gynecology",
    "pediatrics",
    "pediatrician",
    "oncology",
    "oncologist",
    "psychiatry",
    "psychiatrist",
    "ent",
    "ophthalmology",
    "urology",
    "gastroenterology",
    "pulmonology",
    "endocrinology",
    "nephrology",
    "rheumatology",
    "diabetologist",
  ];
  if (specialties.some((k) => text.includes(k)))
    return { type: "SELECT_SPECIALTY", value: message };

  // ── Navigation / actions ──────────────────────────────────
  if (text.includes("back") || text.includes("main menu") || text.includes("go back"))
    return { type: "BACK_TO_MENU" };
  if (text.includes("cancel") || text.includes("stop"))
    return { type: "CANCEL" };
  if (text.includes("confirm") || text.includes("yes") || text.includes("proceed"))
    return { type: "CONFIRM" };
  if (text.includes("done") || text.includes("finish") || text.includes("completed"))
    return { type: "DONE" };
  if (text.includes("retry") || text.includes("try again"))
    return { type: "RETRY" };

  // ── Fallback ──────────────────────────────────────────────
  return { type: "UNKNOWN" };
}
