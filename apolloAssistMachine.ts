// ============================================================
// Apollo Assist – XState v5 State Machine
// ============================================================
// Install: npm install xstate
// Docs: https://stately.ai/docs/xstate-v5
// ============================================================

import { createMachine, createActor, assign } from "xstate";
import { allCities, getDoctorsByName, mapSymptomToSpecialty } from "./src/knowledgeBase";
import { AppEvent, mapInputToEvent } from "./src/inputMapping.js";

// ─────────────────────────────────────────────────────────────
// CONTEXT  (shared session data)
// ─────────────────────────────────────────────────────────────

interface ApolloContext {
  doctorName?: string;
  doctorSuggestions?: string;
  specialty?: string;
  city?: string;
  branch?: string;
  searchByLocation?: boolean;
  symptomText?: string;
  phoneNumber?: string;
  packageUrl?: string;
  formData?: Record<string, string>;
  // EDOC booking fields
  resourceId?: string;       // EDOC doctor ResourceID
  locationId?: string;       // EDOC LocationID
  regionId?: string;         // EDOC RegionID (default "5")
  serviceId?: string;        // EDOC ServiceID
  uhid?: string;             // Patient UHID
  appointmentId?: string;    // Booked appointment ID
  selectedDate?: string;     // "01-JUL-2025"
  selectedSlotStart?: string; // "21:00"
  selectedSlotEnd?: string;   // "21:15"
  patientFirstName?: string;
  patientLastName?: string;
  patientDob?: string;        // "03-Jun-1998"
}

function normalizeDoctorName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bdr\.?\s*/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findDoctorMatches(query: string) {
  const matches = getDoctorsByName(query, 8);
  const normalizedQuery = normalizeDoctorName(query);
  const exactMatches = matches.filter(
    (d) => normalizeDoctorName(d.name) === normalizedQuery
  );
  return { matches, exactMatches };
}

// ─────────────────────────────────────────────────────────────
// 3. STATE MACHINE
// ─────────────────────────────────────────────────────────────

/** Shared assign action for AI_PREFILL: sets specialty/city/branch/doctorName from JSON */
function parsePrefill(value: string | undefined): Partial<ApolloContext> {
  try { return JSON.parse(value ?? "{}") as Partial<ApolloContext>; } catch { return {}; }
}

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
          // AI intent shortcut: skip all menu steps and jump straight to results
          AI_PREFILL: {
            target: "SEARCH_DOCTORS_BY_CRITERIA",
            actions: assign({
              specialty:        ({ event }) => parsePrefill(event.value).specialty,
              city:             ({ event }) => parsePrefill(event.value).city,
              branch:           ({ event }) => parsePrefill(event.value).branch,
              doctorName:       ({ event }) => parsePrefill(event.value).doctorName,
              searchByLocation: ({ event }) => !!(parsePrefill(event.value).city),
            }),
          },
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
          AI_PREFILL: {
            target: "SEARCH_DOCTORS_BY_CRITERIA",
            actions: assign({
              specialty:        ({ event }) => parsePrefill(event.value).specialty,
              city:             ({ event }) => parsePrefill(event.value).city,
              branch:           ({ event }) => parsePrefill(event.value).branch,
              doctorName:       ({ event }) => parsePrefill(event.value).doctorName,
              searchByLocation: ({ event }) => !!(parsePrefill(event.value).city),
            }),
          },
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
            actions: assign({
              doctorName: ({ event }) => event.value,
              doctorSuggestions: () => undefined,
            }),
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
              return findDoctorMatches(name).exactMatches.length === 1;
            },
            target: "DOCTOR_FOUND",
            actions: assign({
              doctorName: ({ context }) =>
                findDoctorMatches(context.doctorName ?? "").exactMatches[0]?.name ??
                context.doctorName,
              doctorSuggestions: () => undefined,
            }),
          },
          {
            guard: ({ context }) => {
              const name = context.doctorName ?? "";
              return findDoctorMatches(name).matches.length === 1;
            },
            target: "DOCTOR_FOUND",
            actions: assign({
              doctorName: ({ context }) =>
                findDoctorMatches(context.doctorName ?? "").matches[0]?.name ??
                context.doctorName,
              doctorSuggestions: () => undefined,
            }),
          },
          {
            guard: ({ context }) => {
              const name = context.doctorName ?? "";
              return findDoctorMatches(name).matches.length > 1;
            },
            target: "DOCTOR_NAME_SUGGESTIONS",
            actions: assign({
              doctorSuggestions: ({ context }) =>
                findDoctorMatches(context.doctorName ?? "")
                  .matches.map((d) => d.name)
                  .join("||"),
            }),
          },
          { target: "DOCTOR_NOT_FOUND" },
        ],
      },

      DOCTOR_NAME_SUGGESTIONS: {
        on: {
          SELECT_DOCTOR: {
            target: "PROCESS_DOCTOR_NAME",
            actions: assign({
              doctorName: ({ event }) => event.value,
              doctorSuggestions: () => undefined,
            }),
          },
          ENTER_NAME: {
            target: "PROCESS_DOCTOR_NAME",
            actions: assign({
              doctorName: ({ event }) => event.value,
              doctorSuggestions: () => undefined,
            }),
          },
          SEARCH_BY_SPECIALTY: "SELECT_SPECIALTY",
          RETRY_NAME: "ENTER_DOCTOR_NAME",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      DOCTOR_FOUND: {
        // Always search — city/branch are optional filters, not requirements.
        // If city was pre-selected, the /api/doctors endpoint scopes the results automatically.
        always: { target: "SEARCH_DOCTORS_BY_CRITERIA" },
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
        // Always search across all locations; city/branch are optional filters.
        always: { target: "SEARCH_DOCTORS_BY_CRITERIA" },
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
          // AI mapped symptom → skip category drill-down, jump straight to specialty search
          AI_SYMPTOM_MAPPED: {
            target: "SEARCH_DOCTORS_BY_CRITERIA",
            actions: assign({
              specialty: ({ event }) => event.value,
              searchByLocation: () => false,
            }),
          },
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
          SELECT_SLOT: {
            target: "ENTER_PHONE_FOR_BOOKING",
            actions: assign({
              resourceId: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).resourceId; } catch { return undefined; }
              },
              locationId: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).locationId; } catch { return undefined; }
              },
              regionId: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).regionId ?? "5"; } catch { return "5"; }
              },
              serviceId: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).serviceId; } catch { return undefined; }
              },
              selectedDate: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).date; } catch { return undefined; }
              },
              selectedSlotStart: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).startTime; } catch { return undefined; }
              },
              selectedSlotEnd: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).endTime; } catch { return undefined; }
              },
            }),
          },
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
            target: "SEARCH_DOCTORS_BY_CRITERIA",
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

      // ── Real EDOC booking flow ─────────────────────────────
      ENTER_PHONE_FOR_BOOKING: {
        on: {
          ENTER_PHONE: {
            target: "PROCESS_UHID",
            actions: assign({ phoneNumber: ({ event }) => event.value }),
          },
          BACK_TO_MENU: "SHOW_DOCTORS",
          UNKNOWN: "FALLBACK",
        },
      },

      PROCESS_UHID: {
        on: {
          UHID_FOUND: {
            target: "CONFIRM_APPOINTMENT",
            actions: assign({ uhid: ({ event }) => event.value }),
          },
          UHID_NOT_FOUND: "COLLECT_PATIENT_DETAILS",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      COLLECT_PATIENT_DETAILS: {
        on: {
          ENTER_PATIENT_DETAILS: {
            target: "GENERATE_UHID_STATE",
            actions: assign({
              patientFirstName: ({ event }) => {
                // Last token is DOB if it looks like a date, otherwise use first word as name
                const parts = event.value.trim().split(/\s+/);
                const lastIsDate = /^\d{1,2}[-\/][a-zA-Z0-9]{2,3}[-\/]\d{2,4}$/.test(parts[parts.length - 1] ?? "");
                const nameParts = lastIsDate ? parts.slice(0, -1) : parts;
                return nameParts[0] ?? "Patient";
              },
              patientLastName: ({ event }) => {
                const parts = event.value.trim().split(/\s+/);
                const lastIsDate = /^\d{1,2}[-\/][a-zA-Z0-9]{2,3}[-\/]\d{2,4}$/.test(parts[parts.length - 1] ?? "");
                const nameParts = lastIsDate ? parts.slice(0, -1) : parts;
                return nameParts.slice(1).join(" ") || "User";
              },
              patientDob: ({ event }) => {
                const parts = event.value.trim().split(/\s+/);
                const last = parts[parts.length - 1] ?? "";
                const lastIsDate = /^\d{1,2}[-\/][a-zA-Z0-9]{2,3}[-\/]\d{2,4}$/.test(last);
                return lastIsDate ? last.replace(/\//g, "-") : "01-Jan-1990";
              },
            }),
          },
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      GENERATE_UHID_STATE: {
        on: {
          UHID_GENERATED: {
            target: "CONFIRM_APPOINTMENT",
            actions: assign({ uhid: ({ event }) => event.value }),
          },
          UHID_FAILED: "UHID_GENERATE_FAILED",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      UHID_GENERATE_FAILED: {
        on: {
          // Skip UHID — proceed with phone as patient reference
          SKIP_UHID: {
            target: "CONFIRM_APPOINTMENT",
            actions: assign({ uhid: ({ context }) => `TEMP-${context.phoneNumber ?? "unknown"}` }),
          },
          RETRY_PATIENT_DETAILS: "COLLECT_PATIENT_DETAILS",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      CONFIRM_APPOINTMENT: {
        on: {
          CONFIRM_BOOKING_REAL: "PROCESS_BOOKING",
          CANCEL: "SHOW_DOCTORS",
          BACK_TO_MENU: "MAIN_MENU",
          UNKNOWN: "FALLBACK",
        },
      },

      PROCESS_BOOKING: {
        on: {
          BOOKING_DONE: {
            target: "BOOKING_CONFIRMED",
            actions: assign({ appointmentId: ({ event }) => event.value }),
          },
          BOOKING_FAILED: "BOOKING_FAILED_STATE",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      BOOKING_FAILED_STATE: {
        on: {
          RETRY: "CONFIRM_APPOINTMENT",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      BOOKING_CONFIRMED: {
        on: {
          RESCHEDULE: "RESCHEDULE_APPOINTMENT",
          CANCEL_BOOKING: "CANCEL_APPOINTMENT_STATE",
          DONE: "MAIN_MENU",
        },
      },

      RESCHEDULE_APPOINTMENT: {
        on: {
          SELECT_SLOT: {
            target: "PROCESS_RESCHEDULE",
            actions: assign({
              selectedDate: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).date; } catch { return undefined; }
              },
              selectedSlotStart: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).startTime; } catch { return undefined; }
              },
              selectedSlotEnd: ({ event }) => {
                try { return (JSON.parse(event.value ?? "{}") as Record<string,string>).endTime; } catch { return undefined; }
              },
            }),
          },
          BACK_TO_MENU: "BOOKING_CONFIRMED",
          UNKNOWN: "FALLBACK",
        },
      },

      PROCESS_RESCHEDULE: {
        on: {
          RESCHEDULE_DONE: {
            target: "BOOKING_CONFIRMED",
            actions: assign({ appointmentId: ({ event }) => event.value }),
          },
          RESCHEDULE_FAILED: "RESCHEDULE_FAILED_STATE",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      RESCHEDULE_FAILED_STATE: {
        on: {
          RETRY: "RESCHEDULE_APPOINTMENT",
          BACK_TO_MENU: "BOOKING_CONFIRMED",
        },
      },

      CANCEL_APPOINTMENT_STATE: {
        on: {
          CONFIRM_CANCEL: "PROCESS_CANCEL",
          CANCEL: "BOOKING_CONFIRMED",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      PROCESS_CANCEL: {
        on: {
          CANCEL_DONE: "MAIN_MENU",
          CANCEL_FAILED: "CANCEL_FAILED_STATE",
          BACK_TO_MENU: "MAIN_MENU",
        },
      },

      CANCEL_FAILED_STATE: {
        on: {
          RETRY: "CANCEL_APPOINTMENT_STATE",
          BACK_TO_MENU: "BOOKING_CONFIRMED",
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
          BACK_TO_MENU: "MAIN_MENU",
          AI_PREFILL: {
            target: "SEARCH_DOCTORS_BY_CRITERIA",
            actions: assign({
              specialty:        ({ event }) => parsePrefill(event.value).specialty,
              city:             ({ event }) => parsePrefill(event.value).city,
              branch:           ({ event }) => parsePrefill(event.value).branch,
              doctorName:       ({ event }) => parsePrefill(event.value).doctorName,
              searchByLocation: ({ event }) => !!(parsePrefill(event.value).city),
            }),
          },
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
