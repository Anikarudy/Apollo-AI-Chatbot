// ============================================================
// Apollo Assist – XState v5 State Machine
// ============================================================
// Install: npm install xstate
// Docs: https://stately.ai/docs/xstate-v5
// ============================================================

import { createMachine, createActor, assign } from "xstate";
import { allCities, mapSymptomToSpecialty } from "./src/knowledgeBase";
import { AppEvent, mapInputToEvent } from "./src/inputMapping.js";

// ─────────────────────────────────────────────────────────────
// CONTEXT  (shared session data)
// ─────────────────────────────────────────────────────────────

interface ApolloContext {
  doctorName?: string;
  specialty?: string;
  city?: string;
  branch?: string;
  searchByLocation?: boolean;
  symptomText?: string;
  phoneNumber?: string;
  packageUrl?: string;
  formData?: Record<string, string>;
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

    on: {
      // Global emergency handling: reachable from ANY state
      EMERGENCY: { target: ".SHOW_EMERGENCY_MESSAGE" },
    },

    states: {
      // ── Entry ──────────────────────────────────────────────
      WELCOME: {
        on: {
          START: "MAIN_MENU",
          BOOK_APPOINTMENT: {
            target: "BOOK_APPT_OPTIONS",
            actions: assign({ searchByLocation: () => false }),
          },
          BOOK_BY_LOCATION: {
            target: "ASK_CITY_FOR_LOCATION",
            actions: assign({ searchByLocation: () => true }),
          },
          FIND_DOCTOR: "FIND_DOCTOR_OPTIONS",
          HEALTH_CHECKUP: "HEALTH_CHECKUP_ENTRY",
          INTERNATIONAL_SERVICES: "ASK_DETAILS",
          EMERGENCY: "SHOW_EMERGENCY_MESSAGE",
        },
      },

      MAIN_MENU: {
        on: {
          BOOK_APPOINTMENT: {
            target: "BOOK_APPT_OPTIONS",
            actions: assign({ searchByLocation: () => false }),
          },
          BOOK_BY_LOCATION: {
            target: "ASK_CITY_FOR_LOCATION",
            actions: assign({ searchByLocation: () => true }),
          },
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
          UNKNOWN: "FALLBACK",
        },
      },

      FIND_DOCTOR_OPTIONS: {
        on: {
          BY_SPECIALTY: "SELECT_SPECIALTY",
          BY_DOCTOR_NAME: "ENTER_DOCTOR_NAME",
          BY_SYMPTOMS: "ASK_BASIC_DETAILS",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
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
        always: { target: "SEARCH_DOCTOR" },
      },

      // ── Search doctor by name ──────────────────────────────
      SEARCH_DOCTOR: {
        always: [
          {
            guard: ({ context }) => {
              const name = context.doctorName ?? "";
              return name.length > 0;
            },
            target: "DOCTOR_FOUND",
          },
          { target: "DOCTOR_NOT_FOUND" },
        ],
      },

      DOCTOR_FOUND: {
        always: [
          {
            guard: ({ context }) => {
              const city = context.city ?? "";
              const branch = context.branch ?? "";
              return city.length > 0 && branch.length > 0;
            },
            target: "SEARCH_DOCTORS_BY_CRITERIA",
          },
          { target: "ASK_CITY" },
        ],
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
        always: { target: "SEARCH_BY_SPECIALTY_STATE" },
      },

      // ── Search doctor by specialty ─────────────────────────
      SEARCH_BY_SPECIALTY_STATE: {
        always: [
          {
            guard: ({ context }) => {
              const specialty = context.specialty ?? "";
              return specialty.length > 0;
            },
            target: "SPECIALTY_FOUND",
          },
          { target: "SPECIALTY_NOT_FOUND" },
        ],
      },

      SPECIALTY_FOUND: {
        always: [
          {
            guard: ({ context }) => {
              const city = context.city ?? "";
              const branch = context.branch ?? "";
              return city.length > 0 && branch.length > 0;
            },
            target: "SEARCH_DOCTORS_BY_CRITERIA",
          },
          { target: "ASK_CITY" },
        ],
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
          UNKNOWN: "FALLBACK",
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
          CONTINUE: [
            {
              guard: ({ context }) => {
                const city = context.city ?? "";
                const branch = context.branch ?? "";
                return city.length > 0 && branch.length > 0;
              },
              target: "SEARCH_DOCTORS_BY_CRITERIA",
            },
            { target: "ASK_CITY" },
          ],
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
            target: "SEARCH_DOCTORS_BY_CRITERIA",
            actions: assign({ branch: ({ event }) => event.value }),
          },
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      // ── Search doctors by all criteria (name, specialty, location) ────
      SEARCH_DOCTORS_BY_CRITERIA: {
        always: [
          {
            guard: ({ context }) => {
              const hasName = context.doctorName ?? "";
              const hasSpec = context.specialty ?? "";
              const hasCity = context.city ?? "";
              return hasName.length > 0 || hasSpec.length > 0 || hasCity.length > 0;
            },
            target: "DOCTORS_FOUND",
          },
          { target: "DOCTOR_NOT_FOUND" },
        ],
      },

      DOCTORS_FOUND: {
        always: { target: "SHOW_DOCTORS" },
      },

      DOCTOR_NOT_FOUND: {
        on: {
          RETRY_NAME: "ENTER_DOCTOR_NAME",
          SEARCH_BY_SPECIALTY: "SELECT_SPECIALTY",
          CHANGE_CITY: [
            {
              guard: ({ context }) => context.searchByLocation === true,
              target: "ASK_CITY_FOR_LOCATION",
            },
            { target: "ASK_CITY" },
          ],
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      SPECIALTY_NOT_FOUND: {
        on: {
          RETRY_SPECIALTY: "SELECT_SPECIALTY",
          CHANGE_CITY: [
            {
              guard: ({ context }) => context.searchByLocation === true,
              target: "ASK_CITY_FOR_LOCATION",
            },
            { target: "ASK_CITY" },
          ],
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      SHOW_DOCTORS: {
        on: {
          SELECT_SLOT: "CONFIRM_BOOKING",
          CHANGE_SEARCH: [
            {
              guard: ({ context }) => {
                return context.searchByLocation === true;
              },
              target: "BOOK_APPT_OPTIONS_LOCATION",
            },
            { target: "BOOK_APPT_OPTIONS" },
          ],
          CHANGE_SPECIALTY: "SELECT_SPECIALTY",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      BOOK_APPT_OPTIONS_LOCATION: {
        on: {
          KNOW_DOCTOR_NAME: "ENTER_DOCTOR_NAME",
          FIND_BY_SPECIALTY: "SELECT_SPECIALTY",
          HAVE_SYMPTOMS: "ASK_BASIC_DETAILS",
          CHANGE_CITY: {
            target: "ASK_CITY_FOR_LOCATION",
            actions: assign({
              branch: () => undefined,
              searchByLocation: () => true,
            }),
          },
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      CONFIRM_BOOKING: {
        on: {
          CONTINUE: "ENTER_PHONE",
          CANCEL: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      // ── Location-based booking flow ─────────────────────────
      // ── Location-based booking workflow entry ──────────────
      ASK_CITY_FOR_LOCATION: {
        on: {
          ENTER_CITY: {
            target: "ASK_BRANCH_FOR_LOCATION",
            actions: assign({
              city: ({ event }) => event.value,
              branch: () => undefined,
            }),
          },
          SELECT_CITY: {
            target: "ASK_BRANCH_FOR_LOCATION",
            actions: assign({
              city: ({ event }) => event.value,
              branch: () => undefined,
            }),
          },
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      ASK_BRANCH_FOR_LOCATION: {
        on: {
          SELECT_BRANCH: {
            target: "BOOK_APPT_OPTIONS_LOCATION",
            actions: assign({ branch: ({ event }) => event.value }),
          },
          CHANGE_CITY: "ASK_CITY_FOR_LOCATION",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
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
          UNKNOWN: "FALLBACK",
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
          UNKNOWN: "FALLBACK",
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
          ENTER_PARTIAL_DETAILS: {
            target: "CHECK_MISSING_DETAILS",
            actions: assign({ 
              formData: ({ context }) => ({
                ...context.formData,
                // Accumulate form data in context
                partialEntry: new Date().toISOString(),
              }),
            }),
          },
          ENTER_ALL_DETAILS: {
            target: "CONFIRM_SUBMISSION",
            actions: assign({ 
              formData: ({ context }) => ({
                ...context.formData,
                completeEntry: new Date().toISOString(),
              }),
            }),
          },
          REFUSE_DETAIL: "HANDLE_REFUSAL",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      CHECK_MISSING_DETAILS: {
        on: {
          MISSING_FIELDS: "ASK_SPECIFIC_DETAIL",
          ALL_FIELDS_PRESENT: "CONFIRM_SUBMISSION",
          UNKNOWN: "FALLBACK",
        },
      },

      ASK_SPECIFIC_DETAIL: {
        on: {
          PROVIDE_DETAIL: {
            target: "CHECK_MISSING_DETAILS",
            actions: assign({ 
              formData: ({ context }) => ({
                ...context.formData,
                // Accumulate additional details
                detailUpdated: new Date().toISOString(),
              }),
            }),
          },
          REFUSE_DETAIL: "HANDLE_REFUSAL",
          UNKNOWN: "FALLBACK",
        },
      },

      HANDLE_REFUSAL: {
        on: {
          SHOW_CONTACT_OPTION: "PROVIDE_CONTACT_DETAILS",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      PROVIDE_CONTACT_DETAILS: {
        on: {
          DONE: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
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
