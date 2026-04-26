// ============================================================
// Apollo Assist – XState v5 State Machine
// ============================================================
// Install: npm install xstate
// Docs: https://stately.ai/docs/xstate-v5
// ============================================================

import { createMachine, createActor, assign } from "xstate";
import { allCities, mapSymptomToSpecialty } from "./src/knowledgeBase";

// ─────────────────────────────────────────────────────────────
// 1. INPUT MAPPING  (text → event)
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
  | { type: "FOUND" }
  | { type: "NOT_FOUND" }
  | { type: "SELECT_SLOT" }
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
  | { type: "UNKNOWN" };

/**
 * mapInputToEvent
 * Converts a raw user text string into a typed AppEvent.
 * Uses simple keyword detection – extend the arrays freely.
 */
export function mapInputToEvent(message: string, currentState?: string): AppEvent {
  const text = message.toLowerCase().trim();
  const state = (currentState ?? "").toUpperCase();

  if (!text) return { type: "UNKNOWN" };

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

  // ── Find doctor ───────────────────────────────────────────
  const findDoc = [
    "find doctor",
    "find a doctor",
    "search doctor",
    "look for doctor",
    "doctor list",
  ];
  if (findDoc.some((k) => text.includes(k))) return { type: "FIND_DOCTOR" };

  // ── Health checkup / packages ─────────────────────────────
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

  // ── Doctor name (must match "Dr" or "doctor + name pattern") ─
  const isDrTitle = /\bdr\.?\s+\w+/i.test(message);
  const isShortName = /^[A-Z][a-z]{2,15}(\s[A-Z][a-z]{2,15})?$/.test(
    message.trim()
  );
  if (isDrTitle || isShortName) return { type: "ENTER_NAME", value: message };

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

  // ── State-aware free-text mapping ─────────────────────────
  if (state === "ENTER_DOCTOR_NAME") {
    return { type: "ENTER_NAME", value: message.trim() };
  }

  if (state === "SELECT_SPECIALTY") {
    return { type: "ENTER_SPECIALTY", value: message.trim() };
  }

  if (state === "ASK_BASIC_DETAILS") {
    return { type: "ENTER_SYMPTOM", value: message.trim() };
  }

  if (state === "ASK_CITY" || state === "HEALTH_CHECKUP_ENTRY") {
    const cityMatch = allCities.find((city) => {
      const lower = city.toLowerCase();
      return lower === text || lower.includes(text) || text.includes(lower);
    });
    return { type: "ENTER_CITY", value: cityMatch ?? message.trim() };
  }

  if (state === "ASK_BRANCH") {
    return { type: "SELECT_BRANCH", value: message.trim() };
  }

  if (state === "ENTER_PHONE") {
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

  // ── Fallback ──────────────────────────────────────────────
  return { type: "UNKNOWN" };
}

// ─────────────────────────────────────────────────────────────
// 2. CONTEXT  (shared session data)
// ─────────────────────────────────────────────────────────────

interface ApolloContext {
  doctorName?: string;
  specialty?: string;
  city?: string;
  branch?: string;
  symptomText?: string;
  phoneNumber?: string;
  packageUrl?: string;
}

// ─────────────────────────────────────────────────────────────
// 3. STATE MACHINE
// ─────────────────────────────────────────────────────────────

export const apolloMachine = createMachine(
  {
    id: "ApolloAssist",
    initial: "WELCOME",
    types: {} as { context: ApolloContext; events: AppEvent },
    context: {},

    states: {
      // ── Entry ──────────────────────────────────────────────
      WELCOME: {
        on: {
          START: "MAIN_MENU",
          BOOK_APPOINTMENT: "BOOK_APPT_OPTIONS",
          FIND_DOCTOR: "FIND_DOCTOR_OPTIONS",
          HEALTH_CHECKUP: "HEALTH_CHECKUP_ENTRY",
          INTERNATIONAL_SERVICES: "ASK_DETAILS",
          EMERGENCY: "SHOW_EMERGENCY_MESSAGE",
        },
      },

      MAIN_MENU: {
        on: {
          BOOK_APPOINTMENT: "BOOK_APPT_OPTIONS",
          FIND_DOCTOR: "FIND_DOCTOR_OPTIONS",
          HEALTH_CHECKUP: "HEALTH_CHECKUP_ENTRY",
          INTERNATIONAL_SERVICES: "ASK_DETAILS",
          EMERGENCY: "SHOW_EMERGENCY_MESSAGE",
          UNKNOWN: "FALLBACK",
        },
      },

      // ── Appointment entry ──────────────────────────────────
      BOOK_APPT_OPTIONS: {
        on: {
          KNOW_DOCTOR_NAME: "ENTER_DOCTOR_NAME",
          FIND_BY_SPECIALTY: "SELECT_SPECIALTY",
          HAVE_SYMPTOMS: "ASK_BASIC_DETAILS",
          HEALTH_CHECKUP: "HEALTH_CHECKUP_ENTRY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      FIND_DOCTOR_OPTIONS: {
        on: {
          BY_SPECIALTY: "SELECT_SPECIALTY",
          BY_DOCTOR_NAME: "ENTER_DOCTOR_NAME",
          BY_SYMPTOMS: "ASK_BASIC_DETAILS",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      // ── Doctor-name flow ───────────────────────────────────
      ENTER_DOCTOR_NAME: {
        on: {
          ENTER_NAME: {
            target: "PROCESS_DOCTOR_NAME",
            actions: assign({ doctorName: ({ event }) => event.value }),
          },
          UNKNOWN: "FALLBACK",
        },
      },

      PROCESS_DOCTOR_NAME: {
        on: {
          AUTO: "ASK_CITY",
          RETRY_NAME: "ENTER_DOCTOR_NAME",
          SEARCH_BY_SPECIALTY: "SELECT_SPECIALTY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      // ── Specialty flow ─────────────────────────────────────
      SELECT_SPECIALTY: {
        on: {
          SELECT_SPECIALTY: {
            target: "PROCESS_SPECIALTY",
            actions: assign({ specialty: ({ event }) => event.value }),
          },
          ENTER_SPECIALTY: {
            target: "PROCESS_SPECIALTY",
            actions: assign({ specialty: ({ event }) => event.value }),
          },
          UNKNOWN: "FALLBACK",
        },
      },

      PROCESS_SPECIALTY: {
        always: { target: "ASK_CITY" },
      },

      // ── Symptom flow ───────────────────────────────────────
      ASK_BASIC_DETAILS: {
        on: {
          ENTER_SYMPTOM: {
            target: "SELECT_SYMPTOM_CATEGORY",
            actions: assign({ symptomText: ({ event }) => event.value }),
          },
          SELECT_CATEGORY: "SELECT_SYMPTOM_CATEGORY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      SELECT_SYMPTOM_CATEGORY: {
        on: {
          SELECT_CATEGORY: "PROCESS_SYMPTOM_CATEGORY",
          ENTER_SYMPTOM_TEXT: "PROCESS_SYMPTOM_CATEGORY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      PROCESS_SYMPTOM_CATEGORY: {
        always: { target: "SELECT_SYMPTOM_DETAIL" },
      },

      SELECT_SYMPTOM_DETAIL: {
        on: {
          SELECT_DETAIL: "PROCESS_SYMPTOM_DETAIL",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      PROCESS_SYMPTOM_DETAIL: {
        always: { target: "MAP_TO_SPECIALTY" },
      },

      MAP_TO_SPECIALTY: {
        always: {
          target: "SHOW_SPECIALTY_RESULT",
          actions: assign({
            specialty: ({ context }) =>
              mapSymptomToSpecialty(context.symptomText ?? "") ?? context.specialty,
          }),
        },
      },

      SHOW_SPECIALTY_RESULT: {
        on: {
          CONTINUE: "ASK_CITY",
          CHANGE_SPECIALTY: "SELECT_SYMPTOM_CATEGORY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      // ── Shared location steps ──────────────────────────────
      ASK_CITY: {
        on: {
          ENTER_CITY: {
            target: "ASK_BRANCH",
            actions: assign({ city: ({ event }) => event.value }),
          },
          SELECT_CITY: {
            target: "ASK_BRANCH",
            actions: assign({ city: ({ event }) => event.value }),
          },
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      ASK_BRANCH: {
        on: {
          SELECT_BRANCH: {
            target: "SHOW_DOCTORS",
            actions: assign({ branch: ({ event }) => event.value }),
          },
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      SHOW_DOCTORS: {
        on: {
          SELECT_SLOT: "CONFIRM_BOOKING",
          CHANGE_SEARCH: "BOOK_APPT_OPTIONS",
          CHANGE_SPECIALTY: "SELECT_SPECIALTY",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      DOCTOR_NOT_FOUND: {
        on: {
          RETRY_NAME: "ENTER_DOCTOR_NAME",
          SEARCH_BY_SPECIALTY: "SELECT_SPECIALTY",
          CHANGE_CITY: "ASK_CITY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      SPECIALTY_NOT_FOUND: {
        on: {
          RETRY_SPECIALTY: "SELECT_SPECIALTY",
          CHANGE_CITY: "ASK_CITY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      // ── Booking + OTP ──────────────────────────────────────
      CONFIRM_BOOKING: {
        on: {
          CONTINUE: "ENTER_PHONE",
          CANCEL: "MAIN_MENU",
        },
      },

      ENTER_PHONE: {
        on: {
          ENTER_PHONE: {
            target: "VERIFY_OTP",
            actions: assign({ phoneNumber: ({ event }) => event.value }),
          },
          EXIT_VERIFICATION: "SHOW_DOCTORS",
          UNKNOWN: "FALLBACK",
        },
      },

      VERIFY_OTP: {
        on: {
          OTP_SUCCESS: "BOOKING_SUCCESS",
          EXIT_VERIFICATION: "SHOW_DOCTORS",
        },
      },

      BOOKING_SUCCESS: {
        on: {
          DONE: "MAIN_MENU",
        },
      },

      // ── Health checkup ─────────────────────────────────────
      HEALTH_CHECKUP_ENTRY: {
        on: {
          ENTER_CITY: {
            target: "SHOW_PACKAGES",
            actions: assign({ city: ({ event }) => event.value }),
          },
          SELECT_CITY: {
            target: "SHOW_PACKAGES",
            actions: assign({ city: ({ event }) => event.value }),
          },
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      SHOW_PACKAGES: {
        on: {
          VIEW_PACKAGE_DETAILS: {
            target: "REDIRECT_TO_WEBSITE",
            actions: assign({ packageUrl: ({ event }) => event.value }),
          },
          ASK_TO_BOOK: "PROVIDE_CONTACT_NUMBER",
          CHANGE_CITY: "HEALTH_CHECKUP_ENTRY",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      REDIRECT_TO_WEBSITE: {
        on: {
          EXIT: "MAIN_MENU",
        },
      },

      PROVIDE_CONTACT_NUMBER: {
        on: {
          CALL: "MAIN_MENU",
          DONE: "MAIN_MENU",
        },
      },

      // ── International patient ──────────────────────────────
      ASK_DETAILS: {
        on: {
          ENTER_PARTIAL_DETAILS: "CHECK_MISSING_DETAILS",
          ENTER_ALL_DETAILS: "CONFIRM_SUBMISSION",
          REFUSE_DETAIL: "HANDLE_REFUSAL",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      CHECK_MISSING_DETAILS: {
        on: {
          MISSING_FIELDS: "ASK_SPECIFIC_DETAIL",
          ALL_FIELDS_PRESENT: "CONFIRM_SUBMISSION",
        },
      },

      ASK_SPECIFIC_DETAIL: {
        on: {
          PROVIDE_DETAIL: "CHECK_MISSING_DETAILS",
          REFUSE_DETAIL: "HANDLE_REFUSAL",
          UNKNOWN: "FALLBACK",
        },
      },

      HANDLE_REFUSAL: {
        on: {
          SHOW_CONTACT_OPTION: "PROVIDE_CONTACT_DETAILS",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      PROVIDE_CONTACT_DETAILS: {
        on: {
          DONE: "MAIN_MENU",
        },
      },

      CONFIRM_SUBMISSION: {
        on: {
          CONFIRM: "SUBMIT_REQUEST",
          EDIT_DETAILS: "ASK_DETAILS",
          CANCEL: "MAIN_MENU",
        },
      },

      SUBMIT_REQUEST: {
        on: {
          SUCCESS: "SUBMISSION_SUCCESS",
        },
      },

      SUBMISSION_SUCCESS: {
        on: {
          DONE: "MAIN_MENU",
        },
      },

      // ── Emergency ──────────────────────────────────────────
      SHOW_EMERGENCY_MESSAGE: {
        on: {
          CALL_EMERGENCY: "END",
          CONTINUE: "MAIN_MENU",
          END_CONVERSATION: "END",
        },
      },

      // ── Global fallback ────────────────────────────────────
      FALLBACK: {
        on: {
          RETRY: "MAIN_MENU",
        },
      },

      // ── Terminal ───────────────────────────────────────────
      END: {
        type: "final",
      },
    },
  }
);

// ─────────────────────────────────────────────────────────────
// 4. INTEGRATION LAYER  (text input → event → machine)
// ─────────────────────────────────────────────────────────────

/**
 * ApolloAssistRunner
 * Wraps the XState actor and exposes a simple sendMessage() interface.
 * In a real app you'd swap the console.log calls for your chat UI callbacks.
 */
export class ApolloAssistRunner {
  /** Expose actor so the hook can subscribe to snapshots */
  public readonly actor = createActor(apolloMachine);

  constructor() {
    this.actor.subscribe((snapshot) => {
      console.log("[State]", snapshot.value);
      console.log("[Context]", snapshot.context);
    });
    this.actor.start();
  }

  /** Feed a raw user message string into the machine */
  sendMessage(userText: string): void {
    const event = mapInputToEvent(userText, this.currentState);
    console.log("[Mapped event]", event);
    this.actor.send(event as AppEvent);
  }

  /** Send a typed event directly (used by the React hook) */
  sendEvent(event: AppEvent): void {
    this.actor.send(event);
  }

  /** Read current state (useful for rendering buttons) */
  get currentState(): string {
    return this.actor.getSnapshot().value as string;
  }

  /** Read current context */
  get context(): ApolloContext {
    return this.actor.getSnapshot().context;
  }

  stop() {
    this.actor.stop();
  }
}

// ─────────────────────────────────────────────────────────────
// 5. QUICK DEMO (optional)
// ─────────────────────────────────────────────────────────────

export function runDemoConversation(): void {
  const runner = new ApolloAssistRunner();
  runner.sendMessage("Hello");
  runner.sendMessage("I want to book an appointment");
  runner.sendMessage("I have chest pain");
  runner.sendMessage("I want to check cardiologist");
  runner.sendMessage("Hyderabad");
  runner.sendMessage("Apollo Jubilee Hills");
}
