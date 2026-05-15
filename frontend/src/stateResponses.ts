/**
 * stateResponses.ts
 * Maps each XState machine state to a bot message and quick-reply buttons.
 * Buttons carry the exact event type to send to the machine.
 */

import { allCities, specialities, contacts, getSubBranchesForCity, getDoctorsForLocation, getPackagesForCity, getDoctorsByName, buildDoctorSearchUrl, mapSymptomToSpecialty } from "./knowledgeBase";

export { mapSymptomToSpecialty };

export interface QuickReply {
  label: string;
  eventType: string;
  value?: string;
}

export interface StateResponse {
  message: string;
  quickReplies: QuickReply[];
  /** If true, the text input is shown for free text entry */
  showInput?: boolean;
  /** Placeholder for the text input */
  inputPlaceholder?: string;
}

const responses: Record<string, StateResponse> = {
  WELCOME: {
    message:
      "Hi, I'm Apollo Assist, your personal support for all medical needs. How can I help you?",
    quickReplies: [
      { label: "Help me find a doctor", eventType: "FIND_DOCTOR" },
      { label: "I want to book appointment", eventType: "BOOK_APPOINTMENT" },
        { label: "Book by location", eventType: "BOOK_BY_LOCATION" },
      { label: "I want to book health check", eventType: "HEALTH_CHECKUP" },
      { label: "International patient services", eventType: "INTERNATIONAL_SERVICES" },
      { label: "I have an emergency", eventType: "EMERGENCY" },
    ],
  },

  MAIN_MENU: {
    message: "What would you like to do?",
    quickReplies: [
      { label: "Help me find a doctor", eventType: "FIND_DOCTOR" },
      { label: "I want to book appointment", eventType: "BOOK_APPOINTMENT" },
      { label: "Book by location", eventType: "BOOK_BY_LOCATION" },
      { label: "I want to book health check", eventType: "HEALTH_CHECKUP" },
      { label: "International patient services", eventType: "INTERNATIONAL_SERVICES" },
      { label: "I have an emergency", eventType: "EMERGENCY" },
    ],
  },

  BOOK_APPT_OPTIONS: {
    message: "How would you like to search for a doctor?",
    quickReplies: [
      { label: "I know the doctor's name", eventType: "KNOW_DOCTOR_NAME" },
      { label: "Search by specialty", eventType: "FIND_BY_SPECIALTY" },
      { label: "I have symptoms", eventType: "HAVE_SYMPTOMS" },
      { label: "Book a health checkup", eventType: "HEALTH_CHECKUP" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  FIND_DOCTOR_OPTIONS: {
    message: "How would you like to find a doctor?",
    quickReplies: [
      { label: "By specialty", eventType: "BY_SPECIALTY" },
      { label: "By doctor name", eventType: "BY_DOCTOR_NAME" },
      { label: "By symptoms", eventType: "BY_SYMPTOMS" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  ENTER_DOCTOR_NAME: {
    message: "Please enter the doctor's name.",
    quickReplies: [{ label: "Back", eventType: "BACK_TO_MENU" }],
    showInput: true,
    inputPlaceholder: "e.g. Dr. Sharma or Dr. Priya Reddy",
  },

  PROCESS_DOCTOR_NAME: {
    message: "Got it! Let me find that doctor for you.",
    quickReplies: [],
  },

  DOCTOR_NAME_SUGGESTIONS: {
    message: "I found multiple doctors with similar names. Please pick one.",
    quickReplies: [
      { label: "Search by specialty instead", eventType: "SEARCH_BY_SPECIALTY" },
      { label: "Try another name", eventType: "RETRY_NAME" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
    showInput: true,
    inputPlaceholder: "Type/select doctor name…",
  },

  SELECT_SPECIALTY: {
    message: "Which specialty are you looking for? (We have 360+ specialties.)",
    quickReplies: [
      // Top specialties from CRM knowledge base
      { label: "Cardiology", eventType: "SELECT_SPECIALTY", value: "Cardiology" },
      { label: "Neurology", eventType: "SELECT_SPECIALTY", value: "Neurology" },
      { label: "Orthopaedics", eventType: "SELECT_SPECIALTY", value: "Orthopaedics" },
      { label: "Oncology", eventType: "SELECT_SPECIALTY", value: "Oncology" },
      { label: "Gastroenterology", eventType: "SELECT_SPECIALTY", value: "Gastroenterology" },
      { label: "Gynaecology", eventType: "SELECT_SPECIALTY", value: "Gynaecology" },
      { label: "Paediatrics", eventType: "SELECT_SPECIALTY", value: "Paediatrics" },
      { label: "ENT", eventType: "SELECT_SPECIALTY", value: "ENT" },
      { label: "Dermatology", eventType: "SELECT_SPECIALTY", value: "Dermatology" },
      { label: "Urology", eventType: "SELECT_SPECIALTY", value: "Urology" },
    ],
    showInput: true,
    inputPlaceholder: `Type any specialty (${specialities.length} available)…`,
  },

  PROCESS_SPECIALTY: {
    message: "Searching for doctors in that specialty…",
    quickReplies: [],
  },

  ASK_BASIC_DETAILS: {
    message: "Please describe your symptoms so I can suggest the right specialist.",
    quickReplies: [
      { label: "Chest pain / heart issues", eventType: "ENTER_SYMPTOM", value: "chest pain" },
      { label: "Headache / neurological", eventType: "ENTER_SYMPTOM", value: "headache" },
      { label: "Joint / bone pain", eventType: "ENTER_SYMPTOM", value: "joint pain" },
      { label: "Skin issues", eventType: "ENTER_SYMPTOM", value: "skin rash" },
      { label: "Stomach / digestion", eventType: "ENTER_SYMPTOM", value: "stomach pain" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
    showInput: true,
    inputPlaceholder: "Describe your symptoms…",
  },

  SELECT_SYMPTOM_CATEGORY: {
    message: "Which area best describes your concern?",
    quickReplies: [
      { label: "Heart & Chest", eventType: "SELECT_CATEGORY", value: "heart" },
      { label: "Head & Brain", eventType: "SELECT_CATEGORY", value: "neuro" },
      { label: "Bones & Joints", eventType: "SELECT_CATEGORY", value: "ortho" },
      { label: "Skin", eventType: "SELECT_CATEGORY", value: "skin" },
      { label: "Digestion", eventType: "SELECT_CATEGORY", value: "gastro" },
      { label: "Women's Health", eventType: "SELECT_CATEGORY", value: "gynae" },
      { label: "Children's Health", eventType: "SELECT_CATEGORY", value: "paeds" },
    ],
  },

  PROCESS_SYMPTOM_CATEGORY: {
    message: "Analysing your symptoms…",
    quickReplies: [],
  },

  SELECT_SYMPTOM_DETAIL: {
    message: "How severe are your symptoms?",
    quickReplies: [
      { label: "Mild – occasional discomfort", eventType: "SELECT_DETAIL", value: "mild" },
      { label: "Moderate – affects daily life", eventType: "SELECT_DETAIL", value: "moderate" },
      { label: "Severe – need urgent attention", eventType: "SELECT_DETAIL", value: "severe" },
    ],
  },

  PROCESS_SYMPTOM_DETAIL: {
    message: "Mapping your symptoms to the right specialist…",
    quickReplies: [],
  },

  MAP_TO_SPECIALTY: {
    message: "Finding the best specialist for you…",
    quickReplies: [],
  },

  SHOW_SPECIALTY_RESULT: {
    message:
      "Based on your symptoms, I recommend seeing a specialist. Shall I show you available doctors?",
    quickReplies: [
      { label: "Yes, show doctors", eventType: "CONTINUE" },
      { label: "Change my symptoms", eventType: "CHANGE_SPECIALTY" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  ASK_CITY: {
    message: "Which city are you in?",
    quickReplies: [
      // Famous cities first (most popular Apollo locations)
      { label: "Hyderabad", eventType: "SELECT_CITY", value: "Hyderabad" },
      { label: "Chennai", eventType: "SELECT_CITY", value: "Chennai" },
      { label: "Bangalore", eventType: "SELECT_CITY", value: "Bangalore" },
      { label: "Mumbai", eventType: "SELECT_CITY", value: "Mumbai" },
      { label: "Delhi", eventType: "SELECT_CITY", value: "Delhi" },
      { label: "Other cities", eventType: "SELECT_CITY", value: "Other" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
    showInput: true,
    inputPlaceholder: "Or type your city…",
  },

  ASK_BRANCH: {
    message: "Which Apollo Hospital branch would you prefer?",
    quickReplies: [{ label: "Back to menu", eventType: "BACK_TO_MENU" }],
    showInput: true,
    inputPlaceholder: "Type branch name…",
  },

  ASK_CITY_FOR_LOCATION: {
    message: "Which city would you like to book a doctor's appointment in?",
    quickReplies: [
      { label: "Hyderabad", eventType: "SELECT_CITY", value: "Hyderabad" },
      { label: "Chennai", eventType: "SELECT_CITY", value: "Chennai" },
      { label: "Bangalore", eventType: "SELECT_CITY", value: "Bangalore" },
      { label: "Mumbai", eventType: "SELECT_CITY", value: "Mumbai" },
      { label: "Delhi", eventType: "SELECT_CITY", value: "Delhi" },
      { label: "Other cities", eventType: "SELECT_CITY", value: "Other" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
    showInput: true,
    inputPlaceholder: "Or type your city…",
  },

  ASK_BRANCH_FOR_LOCATION: {
    message: "Which Apollo Hospital branch in that city would you like to visit?",
    quickReplies: [
      { label: "Change city", eventType: "CHANGE_CITY" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
    showInput: true,
    inputPlaceholder: "Type or select branch…",
  },

  BOOK_APPT_OPTIONS_LOCATION: {
    message: "How would you like to search at this selected location?",
    quickReplies: [
      { label: "I know the doctor's name", eventType: "KNOW_DOCTOR_NAME" },
      { label: "Search by specialty", eventType: "FIND_BY_SPECIALTY" },
      { label: "I have symptoms", eventType: "HAVE_SYMPTOMS" },
      { label: "Change city", eventType: "CHANGE_CITY" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  SHOW_DOCTORS: {
    message:
      "Here are the available doctors. Select a time slot to book your appointment.",
    quickReplies: [
      { label: "Change search", eventType: "CHANGE_SEARCH" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  // ── EDOC real-booking states ──────────────────────────────────────────
  ENTER_PHONE_FOR_BOOKING: {
    message: "Please enter your mobile number to look up your patient profile (UHID).",
    quickReplies: [{ label: "Go back", eventType: "BACK_TO_MENU" }],
    showInput: true,
    inputPlaceholder: "10-digit mobile number",
  },

  PROCESS_UHID: {
    message: "Looking up your patient profile… please wait.",
    quickReplies: [],
  },

  COLLECT_PATIENT_DETAILS: {
    message: "No existing profile found. Please provide your name and date of birth.\nExample: John Smith 28-04-1990\n(Date format: DD-MM-YYYY)",
    quickReplies: [{ label: "Back to menu", eventType: "BACK_TO_MENU" }],
    showInput: true,
    inputPlaceholder: "FirstName LastName DD-MM-YYYY",
  },

  GENERATE_UHID_STATE: {
    message: "Creating your patient profile… please wait.",
    quickReplies: [],
  },

  UHID_GENERATE_FAILED: {
    message: "Unable to create a patient profile automatically at this time. You can skip this step and proceed with your phone number as a reference, or try again.",
    quickReplies: [
      { label: "Skip & continue booking", eventType: "SKIP_UHID" },
      { label: "Try again", eventType: "RETRY_PATIENT_DETAILS" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  CONFIRM_APPOINTMENT: {
    message: "Please review your booking details and confirm.",
    quickReplies: [
      { label: "Confirm booking", eventType: "CONFIRM_BOOKING_REAL" },
      { label: "Go back", eventType: "CANCEL" },
    ],
  },

  PROCESS_BOOKING: {
    message: "Confirming your appointment… please wait.",
    quickReplies: [],
  },

  BOOKING_FAILED_STATE: {
    message: "Unable to confirm your appointment at this time. This may be a temporary issue with the booking system.",
    quickReplies: [
      { label: "Try again", eventType: "RETRY" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  BOOKING_CONFIRMED: {
    message: "Your appointment has been confirmed! You will receive a confirmation shortly.",
    quickReplies: [
      { label: "Reschedule", eventType: "RESCHEDULE" },
      { label: "Cancel appointment", eventType: "CANCEL_BOOKING" },
      { label: "Back to main menu", eventType: "DONE" },
    ],
  },

  RESCHEDULE_APPOINTMENT: {
    message: "Please select a new date and time slot from the doctor's card above.",
    quickReplies: [
      { label: "Go back", eventType: "BACK_TO_MENU" },
    ],
  },

  PROCESS_RESCHEDULE: {
    message: "Rescheduling your appointment… please wait.",
    quickReplies: [],
  },

  RESCHEDULE_FAILED_STATE: {
    message: "Unable to reschedule your appointment at this time.",
    quickReplies: [
      { label: "Try again", eventType: "RETRY" },
      { label: "Back to booking", eventType: "BACK_TO_MENU" },
    ],
  },

  CANCEL_APPOINTMENT_STATE: {
    message: "Are you sure you want to cancel your appointment? This cannot be undone.",
    quickReplies: [
      { label: "Yes, cancel appointment", eventType: "CONFIRM_CANCEL" },
      { label: "No, keep my appointment", eventType: "CANCEL" },
    ],
  },

  PROCESS_CANCEL: {
    message: "Cancelling your appointment… please wait.",
    quickReplies: [],
  },

  CANCEL_FAILED_STATE: {
    message: "Unable to cancel your appointment at this time. Please try again or call Apollo at 1860-500-1066.",
    quickReplies: [
      { label: "Try again", eventType: "RETRY" },
      { label: "Back to booking", eventType: "BACK_TO_MENU" },
    ],
  },

  DOCTOR_NOT_FOUND: {
    message:
      "Sorry, I couldn't find doctors matching your search. What would you like to do?",
    quickReplies: [
      { label: "Try another name", eventType: "RETRY_NAME" },
      { label: "Search by specialty", eventType: "SEARCH_BY_SPECIALTY" },
      { label: "Change city", eventType: "CHANGE_CITY" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  SPECIALTY_NOT_FOUND: {
    message:
      "No doctors found for that specialty in your area. What would you like to do?",
    quickReplies: [
      { label: "Try another specialty", eventType: "RETRY_SPECIALTY" },
      { label: "Change city", eventType: "CHANGE_CITY" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  CONFIRM_BOOKING: {
    message:
      "Great! I have your appointment details. Shall I proceed to confirm the booking?",
    quickReplies: [
      { label: "Yes, continue", eventType: "CONTINUE" },
      { label: "Cancel", eventType: "CANCEL" },
    ],
  },

  ENTER_PHONE: {
    message: "Please enter your mobile number to receive an OTP for confirmation.",
    quickReplies: [{ label: "Go back", eventType: "EXIT_VERIFICATION" }],
    showInput: true,
    inputPlaceholder: "+91 XXXXX XXXXX",
  },

  VERIFY_OTP: {
    message: "An OTP has been sent to your mobile. Please enter it to confirm your booking.",
    quickReplies: [
      { label: "OTP verified ✓ (simulate)", eventType: "OTP_SUCCESS" },
      { label: "Go back", eventType: "EXIT_VERIFICATION" },
    ],
    showInput: true,
    inputPlaceholder: "Enter OTP…",
  },

  BOOKING_SUCCESS: {
    message:
      "Your appointment has been confirmed! You will receive a confirmation SMS shortly.",
    quickReplies: [{ label: "Back to main menu", eventType: "DONE" }],
  },

  HEALTH_CHECKUP_ENTRY: {
    message: "For health checkup packages, please tell me your city.",
    quickReplies: [
      { label: "Hyderabad", eventType: "SELECT_CITY", value: "Hyderabad" },
      { label: "Chennai", eventType: "SELECT_CITY", value: "Chennai" },
      { label: "Bangalore", eventType: "SELECT_CITY", value: "Bangalore" },
      { label: "Mumbai", eventType: "SELECT_CITY", value: "Mumbai" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
    showInput: true,
    inputPlaceholder: "Or type your city…",
  },

  SHOW_PACKAGES: {
    message:
      "Here are the available health checkup packages in your city. Which one interests you?",
    quickReplies: [
      { label: "View package details", eventType: "VIEW_PACKAGE_DETAILS" },
      { label: "Book a package", eventType: "ASK_TO_BOOK" },
      { label: "Change city", eventType: "CHANGE_CITY" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  REDIRECT_TO_WEBSITE: {
    message:
      "You will be redirected to the Apollo Hospitals website for full package details.",
    quickReplies: [{ label: "Done, exit", eventType: "EXIT" }],
  },

  PROVIDE_CONTACT_NUMBER: {
    message:
      "To book a health checkup, please call our helpline: 1860-500-1066. Our team will assist you.",
    quickReplies: [
      { label: "Call now", eventType: "CALL" },
      { label: "Back to menu", eventType: "DONE" },
    ],
  },

  ASK_DETAILS: {
    message:
      "Welcome! For international patient services, please share your details — name, country, medical condition, and preferred dates.",
    quickReplies: [
      { label: "I'll provide all details", eventType: "ENTER_ALL_DETAILS" },
      { label: "I'll provide some details now", eventType: "ENTER_PARTIAL_DETAILS" },
      { label: "I'd prefer not to share", eventType: "REFUSE_DETAIL" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
    showInput: true,
    inputPlaceholder: "Your name, country, condition…",
  },

  CHECK_MISSING_DETAILS: {
    message: "Checking your submission for completeness…",
    quickReplies: [
      { label: "All fields are present", eventType: "ALL_FIELDS_PRESENT" },
      { label: "Some fields are missing", eventType: "MISSING_FIELDS" },
    ],
  },

  ASK_SPECIFIC_DETAIL: {
    message: "Could you please provide the missing information?",
    quickReplies: [
      { label: "I'll provide it now", eventType: "PROVIDE_DETAIL" },
      { label: "I'd prefer not to", eventType: "REFUSE_DETAIL" },
    ],
    showInput: true,
    inputPlaceholder: "Enter the missing details…",
  },

  HANDLE_REFUSAL: {
    message:
      "That's perfectly fine. Would you like us to contact you instead?",
    quickReplies: [
      { label: "Show contact options", eventType: "SHOW_CONTACT_OPTION" },
      { label: "Back to menu", eventType: "BACK_TO_MENU" },
    ],
  },

  PROVIDE_CONTACT_DETAILS: {
    message:
      "Please contact our International Patient Services team:\n📞 +91-40-2360-7777\n✉ internationalpatients@apollohospitals.com",
    quickReplies: [{ label: "Thank you", eventType: "DONE" }],
  },

  CONFIRM_SUBMISSION: {
    message: "Please review your details. Shall I submit your request?",
    quickReplies: [
      { label: "Confirm & submit", eventType: "CONFIRM" },
      { label: "Edit details", eventType: "EDIT_DETAILS" },
      { label: "Cancel", eventType: "CANCEL" },
    ],
  },

  SUBMIT_REQUEST: {
    message: "Submitting your request…",
    quickReplies: [
      { label: "Request submitted ✓ (simulate)", eventType: "SUCCESS" },
    ],
  },

  SUBMISSION_SUCCESS: {
    message:
      "Your request has been submitted! Our international patient services team will contact you within 24 hours.",
    quickReplies: [{ label: "Back to main menu", eventType: "DONE" }],
  },

  SHOW_EMERGENCY_MESSAGE: {
    message:
      "⚠️ EMERGENCY — Please call Apollo Emergency immediately:\n🚨 1066 (toll-free)\n📞 040-2360-7777\n\nIf you are in immediate danger, call 112 (national emergency).",
    quickReplies: [
      { label: "Call Emergency now", eventType: "CALL_EMERGENCY" },
      { label: "I'm okay, go to main menu", eventType: "CONTINUE" },
      { label: "End conversation", eventType: "END_CONVERSATION" },
    ],
  },

  FALLBACK: {
    message:
      "I'm sorry, I didn't understand that. Let me take you back to the main menu.",
    quickReplies: [{ label: "OK, go to main menu", eventType: "RETRY" }],
  },

  END: {
    message: "Thank you for using Apollo Assist. Take care and stay healthy! 💙",
    quickReplies: [],
  },
};

export type ChatContext = Record<string, string | undefined>;

/**
 * Returns the bot response for a given state.
 * Pass `ctx` (machine context) so dynamic states can show real data.
 */
export function getStateResponse(state: string, ctx?: ChatContext): StateResponse {
  // ── Dynamic: SHOW_PACKAGES ────────────────────────────────────────────
  if (state === "SHOW_PACKAGES") {
    const city = ctx?.city ?? "";
    const packages = getPackagesForCity(city);

    if (packages.length > 0) {
      const list = packages
        .map((p) => `• ${p.name} — ${p.description}`)
        .join("\n");
      const pkgReplies: QuickReply[] = packages.map((p) => ({
        label: p.name,
        eventType: "VIEW_PACKAGE_DETAILS",
        value: p.url,
      }));
      return {
        message: `Here are the Apollo health checkup packages available in ${city}:\n\n${list}\n\nWhich one would you like to know more about?`,
        quickReplies: [
          ...pkgReplies,
          { label: "Change city", eventType: "CHANGE_CITY" },
          { label: "Back to menu", eventType: "BACK_TO_MENU" },
        ],
      };
    }

    // city not in knowledge base (Delhi etc.)
    return {
      message: `We currently have detailed packages for Chennai, Hyderabad, Bangalore, and Mumbai. Please select one of these cities or call 1860-500-1066 for packages in ${city || "your city"}.`,
      quickReplies: [
        { label: "Chennai", eventType: "SELECT_CITY", value: "Chennai" },
        { label: "Hyderabad", eventType: "SELECT_CITY", value: "Hyderabad" },
        { label: "Bangalore", eventType: "SELECT_CITY", value: "Bangalore" },
        { label: "Mumbai", eventType: "SELECT_CITY", value: "Mumbai" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
    };
  }

  // ── Dynamic: ASK_CITY — filter to cities that actually have this doctor ──────
  if (state === "ASK_CITY") {
    const doctorName = ctx?.doctorName ?? "";
    if (doctorName) {
      const matches = getDoctorsByName(doctorName, 200);
      const uniqueCities = Array.from(new Set(matches.map((d) => d.location))).sort();
      if (uniqueCities.length > 0) {
        return {
          message: `${doctorName} is available in ${uniqueCities.length > 1 ? "multiple cities" : uniqueCities[0]}. Which city would you prefer?`,
          quickReplies: [
            ...uniqueCities.map((c) => ({ label: c, eventType: "SELECT_CITY", value: c })),
            { label: "Back to menu", eventType: "BACK_TO_MENU" },
          ],
          showInput: false,
        };
      }
    }
    // Default city picker (specialty/symptom flow)
    return responses["ASK_CITY"]!;
  }

  // ── Dynamic: DOCTOR_NOT_FOUND ────────────────────────────────────────────────
  if (state === "DOCTOR_NOT_FOUND") {
    const name = ctx?.doctorName ?? "";
    return {
      message: name
        ? `Sorry, I couldn't find a doctor named "${name}" in our records. What would you like to do?`
        : "Sorry, I couldn't find any doctors matching your search. What would you like to do?",
      quickReplies: [
        { label: "Try a different name", eventType: "RETRY_NAME" },
        { label: "Search by specialty", eventType: "SEARCH_BY_SPECIALTY" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
    };
  }

  // ── Dynamic: DOCTOR_NOT_FOUND_ASK_CITY ───────────────────────────────────────
  // Triggered when the user's doctor name has no exact match.
  // We ask which city they're in, then run a fuzzy search scoped to that city.
  if (state === "DOCTOR_NOT_FOUND_ASK_CITY") {
    const name = ctx?.doctorName ?? "";
    const cityButtons: QuickReply[] = allCities
      .filter((c) => ["Hyderabad", "Chennai", "Bangalore", "Mumbai", "Delhi"].includes(c))
      .map((c) => ({ label: c, eventType: "SELECT_CITY", value: c }));
    return {
      message: name
        ? `I wasn't able to find an exact match for "${name}". I can look for doctors with similar names — which city would you like to search in?`
        : "I wasn't able to find an exact match. Which city would you like to search in?",
      quickReplies: [
        ...cityButtons,
        { label: "Other cities", eventType: "SELECT_CITY", value: "Other" },
        { label: "Try a different name", eventType: "RETRY_NAME" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
      showInput: true,
      inputPlaceholder: "Or type your city…",
    };
  }

  // ── Dynamic: ASK_BRANCH — sub-branches from new doctor mapping ────────────
  if (state === "ASK_BRANCH") {
    const city = ctx?.city ?? "";
    const doctorName = ctx?.doctorName ?? "";

    // When searching by doctor name, only show branches where that doctor exists
    if (doctorName && city) {
      const cityMatches = getDoctorsByName(doctorName, 200).filter(
        (d) => d.location.toLowerCase() === city.toLowerCase()
      );
      const uniqueBranches = Array.from(new Set(cityMatches.map((d) => d.branch))).sort();
      if (uniqueBranches.length > 0) {
        return {
          message: `${doctorName} is available at ${uniqueBranches.length > 1 ? "multiple branches" : `the ${uniqueBranches[0]} branch`} in ${city}. Which one would you prefer?`,
          quickReplies: [
            ...uniqueBranches.map((b) => ({ label: b, eventType: "SELECT_BRANCH", value: b })),
            { label: "Back to menu", eventType: "BACK_TO_MENU" },
          ],
        };
      }
    }

    const branches = city ? getSubBranchesForCity(city) : [];
    if (branches.length > 0) {
      return {
        message: `Which Apollo Hospital branch in ${city} would you prefer?`,
        quickReplies: [
          ...branches.map((b) => ({
            label: b,
            eventType: "SELECT_BRANCH",
            value: b,
          })),
          { label: "Back to menu", eventType: "BACK_TO_MENU" },
        ],
        showInput: true,
        inputPlaceholder: "Or type branch name…",
      };
    }
    return {
      message: city
        ? `Please type the Apollo Hospital branch in ${city} you prefer, or call 1860-500-1066 for assistance.`
        : "Which Apollo Hospital branch would you prefer?",
      quickReplies: [{ label: "Back to menu", eventType: "BACK_TO_MENU" }],
      showInput: true,
      inputPlaceholder: "Type branch name…",
    };
  }

  if (state === "ASK_BRANCH_FOR_LOCATION") {
    const city = ctx?.city ?? "";
    const branches = city ? getSubBranchesForCity(city) : [];
    if (branches.length > 0) {
      return {
        message: `Which Apollo Hospital branch in ${city} would you like to visit?`,
        quickReplies: [
          ...branches.map((b) => ({
            label: b,
            eventType: "SELECT_BRANCH",
            value: b,
          })),
          { label: "Change city", eventType: "CHANGE_CITY" },
          { label: "Back to menu", eventType: "BACK_TO_MENU" },
        ],
        showInput: true,
        inputPlaceholder: "Or type branch name…",
      };
    }
    return {
      message: city
        ? `Please type the Apollo Hospital branch in ${city} you prefer, or change city.`
        : "Which Apollo Hospital branch would you prefer?",
      quickReplies: [
        { label: "Change city", eventType: "CHANGE_CITY" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
      showInput: true,
      inputPlaceholder: "Type branch name…",
    };
  }

  if (state === "BOOK_APPT_OPTIONS_LOCATION") {
    const city = ctx?.city ?? "";
    const branch = ctx?.branch ?? "";
    const loc = branch ? `${branch}${city ? `, ${city}` : ""}` : city;
    return {
      message: loc
        ? `Great, I will search only within ${loc}. How would you like to find a doctor?`
        : "How would you like to search for a doctor at your selected location?",
      quickReplies: [
        { label: "I know the doctor's name", eventType: "KNOW_DOCTOR_NAME" },
        { label: "Search by specialty", eventType: "FIND_BY_SPECIALTY" },
        { label: "I have symptoms", eventType: "HAVE_SYMPTOMS" },
        { label: "Change city", eventType: "CHANGE_CITY" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
    };
  }


  // ── Dynamic: SHOW_SPECIALTY_RESULT — show matched specialty from ctx ────────
  if (state === "SHOW_SPECIALTY_RESULT") {
    const specialty = ctx?.specialty;
    return {
      message: specialty
        ? `Based on your symptoms, I recommend a ${specialty} specialist. Shall I find available doctors near you?`
        : "Based on your symptoms, I recommend seeing a specialist. Shall I show you available doctors?",
      quickReplies: [
        { label: "Yes, find doctors", eventType: "CONTINUE" },
        { label: "Change symptoms", eventType: "CHANGE_SPECIALTY" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
    };
  }

  // ── Dynamic: PROCESS_DOCTOR_NAME — search doctors from new mapping ──────────
  if (state === "PROCESS_DOCTOR_NAME") {
    const name = ctx?.doctorName ?? "";
    const matches = name ? getDoctorsByName(name) : [];
    if (matches.length > 0) {
      const list = matches.map(d => {
        const loc = d.branch ? `${d.branch}, ${d.location}` : d.location;
        return `• ${d.name} — ${d.speciality} (${loc})`;
      }).join("\n");
      return {
        message: `Found ${matches.length} Apollo doctor(s) matching "${name}":\n\n${list}\n\nTo book an appointment, please select your city next.`,
        quickReplies: [
          { label: "Continue to city selection", eventType: "AUTO" },
          { label: "Try different name", eventType: "RETRY_NAME" },
          { label: "Back to menu", eventType: "BACK_TO_MENU" },
        ],
      };
    }
    return {
      message: `No doctors found matching "${name}" in our directory of 6,900+ Apollo doctors. Try a different spelling or search by specialty instead.`,
      quickReplies: [
        { label: "Search by specialty", eventType: "SEARCH_BY_SPECIALTY" },
        { label: "Try again", eventType: "RETRY_NAME" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
    };
  }

  if (state === "DOCTOR_NAME_SUGGESTIONS") {
    const raw = String(ctx?.doctorSuggestions ?? "");
    const suggestions = Array.from(new Set(raw
      .split("||")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8)));

    const city = ctx?.city ?? "";
    const branch = ctx?.branch ?? "";
    const loc = branch ? `${branch}${city ? `, ${city}` : ""}` : city;

    return {
      message: suggestions.length
        ? `I found multiple matches${loc ? ` for your selected location (${loc})` : ""}. Please choose the correct doctor:`
        : "I found multiple doctor-name matches. Please type the exact doctor name.",
      quickReplies: [
        ...suggestions.map((name) => ({
          label: name,
          eventType: "SELECT_DOCTOR",
          value: name,
        })),
        { label: "Search by specialty instead", eventType: "SEARCH_BY_SPECIALTY" },
        { label: "Try another name", eventType: "RETRY_NAME" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
      showInput: true,
      inputPlaceholder: "Type/select doctor name…",
    };
  }

  // ── Dynamic: SHOW_DOCTORS — serve from local mapping, link to Apollo website ──
  if (state === "SHOW_DOCTORS") {
    const specialty = ctx?.specialty ?? "";
    const branch = ctx?.branch ?? "";
    const city = ctx?.city ?? "";
    const doctorName = ctx?.doctorName ?? "";
    const location = branch ? `${branch}, ${city}` : city;

    const searchUrl = buildDoctorSearchUrl(specialty, city, branch);

    // Count available doctors for the heading using the same filtering rules as /api/doctors
    const localDocs = (city || branch)
      ? getDoctorsForLocation(city, branch || undefined, specialty || undefined)
      : [];
    const normaliseDoctorName = (value: string): string =>
      value
        .toLowerCase()
        .replace(/\bdr\.?\s*/g, "")
        .replace(/[^a-z\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const US_TO_UK: Record<string, string> = {
      pediatrics: "paediatrics",
      gynecology: "gynaecology",
      gynecologist: "gynaecology",
      orthopedics: "orthopaedics",
      anesthesiology: "anaesthesiology",
      "fetal medicine": "foetal medicine",
      hematology: "haematology",
      "hemato oncology": "haemato oncology",
    };
    const normaliseSpecialty = (s: string): string => {
      const lower = s.toLowerCase().trim();
      return US_TO_UK[lower] ?? lower;
    };

    let nameMatches = doctorName ? getDoctorsByName(doctorName, 200) : [];
    if (doctorName) {
      const normInputName = normaliseDoctorName(doctorName);
      if (normInputName.split(" ").filter(Boolean).length >= 2) {
        const exactByFullName = nameMatches.filter(
          (d) => normaliseDoctorName(d.name) === normInputName
        );
        if (exactByFullName.length > 0) nameMatches = exactByFullName;
      }

      if (city) {
        nameMatches = nameMatches.filter(
          (d) => d.location.toLowerCase() === city.toLowerCase()
        );
      }
      if (branch) {
        nameMatches = nameMatches.filter(
          (d) => d.branch.toLowerCase() === branch.toLowerCase()
        );
      }
      if (specialty) {
        const specNorm = normaliseSpecialty(specialty);
        nameMatches = nameMatches.filter((d) => {
          const ds = normaliseSpecialty(d.speciality);
          return ds === specNorm || ds === specialty.toLowerCase();
        });
      }
    }

    let msg = "";
    if (doctorName && nameMatches.length === 1) {
      const found = nameMatches[0];
      const foundLocation = found.branch
        ? `${found.branch}, ${found.location}`
        : found.location;
      msg = `Showing results for ${found.name} at ${foundLocation}.\n\nSelect a time slot below to book, or refine your search.`;
    } else if (location || specialty || doctorName) {
      const parts: string[] = [];
      if (location) parts.push(location);
      if (specialty) parts.push(specialty);
      if (doctorName) parts.push(doctorName);
      msg = `Showing available doctors${parts.length ? ` for ${parts.join(" - ")}` : ""}.\n\nSelect a time slot below to book, or refine your search.`;
    } else {
      msg = `Here are the available Apollo doctors.\n\nSelect a time slot below to book your appointment.`;
    }

    return {
      message: msg,
      quickReplies: [
        { label: "Filter by specialty", eventType: "CHANGE_SEARCH" },
        { label: "Back to menu", eventType: "BACK_TO_MENU" },
      ],
    };
  }

  // ── Dynamic: REDIRECT_TO_WEBSITE — show actual package URL ──────────────────
  if (state === "REDIRECT_TO_WEBSITE") {
    const url = ctx?.packageUrl;
    return {
      message: url
        ? `Book this package directly on Apollo's website:\n\n${url}`
        : `Visit Apollo ProHealth to view full package details and book:\nhttps://prohealth.apollohospitals.com`,
      quickReplies: [{ label: "Done, back to menu", eventType: "EXIT" }],
    };
  }

  // ── Dynamic: CONFIRM_APPOINTMENT — EDOC real booking summary ────────────────
  if (state === "CONFIRM_APPOINTMENT") {
    const specialty = ctx?.specialty ?? "";
    const doctorName = ctx?.doctorName ?? "";
    const branch = ctx?.branch ?? "";
    const city = ctx?.city ?? "";
    const date = ctx?.selectedDate ?? "";
    const startTime = ctx?.selectedSlotStart ?? "";
    const uhid = ctx?.uhid ?? "";
    const who = doctorName || (specialty ? `a ${specialty} specialist` : "your doctor");
    const where = branch ? `${branch}${city ? ", " + city : ""}` : city;
    return {
      message: `Please confirm your booking:\n\n👨‍⚕️ ${who}${where ? `\n📍 ${where}` : ""}${date ? `\n📅 ${date}${startTime ? ` at ${startTime}` : ""}` : ""}${uhid ? `\n🆔 UHID: ${uhid}` : ""}\n\nProceed?`,
      quickReplies: [
        { label: "✅ Confirm booking", eventType: "CONFIRM_BOOKING_REAL" },
        { label: "Go back", eventType: "CANCEL" },
      ],
    };
  }

  // ── Dynamic: BOOKING_CONFIRMED — show appointment ID ────────────────────────
  if (state === "BOOKING_CONFIRMED") {
    const appointmentId = ctx?.appointmentId ?? "";
    const doctorName = ctx?.doctorName ?? "";
    const date = ctx?.selectedDate ?? "";
    const startTime = ctx?.selectedSlotStart ?? "";
    const isRequest = appointmentId === "REQUEST";
    if (isRequest) {
      return {
        message: `✅ Appointment request received!${doctorName ? `\n👨‍⚕️ ${doctorName}` : ""}\n\nAn Apollo representative will contact you to confirm your appointment slot.\n📞 You can also call 1860-500-1066 to book directly.`,
        quickReplies: [
          { label: "Back to main menu", eventType: "DONE" },
        ],
      };
    }
    return {
      message: `✅ Appointment confirmed!${appointmentId ? `\n\n🎫 Appointment ID: ${appointmentId}` : ""}${doctorName ? `\n👨‍⚕️ ${doctorName}` : ""}${date ? `\n📅 ${date}${startTime ? ` at ${startTime}` : ""}` : ""}\n\nYou will receive a confirmation SMS shortly.`,
      quickReplies: [
        { label: "Reschedule", eventType: "RESCHEDULE" },
        { label: "Cancel appointment", eventType: "CANCEL_BOOKING" },
        { label: "Back to main menu", eventType: "DONE" },
      ],
    };
  }

  // ── Dynamic: CONFIRM_BOOKING (legacy flow) ───────────────────────────────────
  if (state === "CONFIRM_BOOKING") {
    const specialty = ctx?.specialty ?? "";
    const doctorName = ctx?.doctorName ?? "";
    const branch = ctx?.branch ?? "";
    const city = ctx?.city ?? "";
    const who = doctorName || (specialty ? `a ${specialty} specialist` : "your doctor");
    const where = branch ? `${branch}${city ? ", " + city : ""}` : city;
    return {
      message: `You're booking an appointment with ${who}${where ? ` at ${where}` : ""}. Shall I proceed to confirm?`,
      quickReplies: [
        { label: "Yes, confirm", eventType: "CONTINUE" },
        { label: "Cancel", eventType: "CANCEL" },
      ],
    };
  }

    // ── Static lookup ─────────────────────────────────────────────────────
  return (
    responses[state] ?? {
      message: `(State: ${state}) — processing…`,
      quickReplies: [{ label: "Back to menu", eventType: "BACK_TO_MENU" }],
    }
  );
}
