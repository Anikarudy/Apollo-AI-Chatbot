# Apollo Assist — QA Testing Guide

This document is for the testing team. It covers setup, all testable workflows, edge cases, known limitations, and what "pass" and "fail" looks like for each scenario.

---

## 1. Setup

### Prerequisites
- Node.js 18+
- A `.env` file in the project root with the following keys (get these from the dev team):

```
GEMINI_API_KEY=...
GROQ_API_KEY=...          # optional — fallback LLM if Gemini fails
EDOC_BASE_URL=...
EDOC_AUTH_KEY=...
```

### Running the app
```bash
npm install
npm run dev
```

The frontend runs at `http://localhost:5173`. The backend API runs at `http://localhost:3000`. Both start together with `npm run dev`.

The chat widget appears as a floating button in the bottom-right corner of the page.

---

## 2. Architecture Overview (for context)

| Layer | Tech | Notes |
|-------|------|-------|
| Frontend | React + TypeScript | Chat widget in `src/components/ChatWidget.tsx` |
| State machine | XState v5 | All conversation flow logic in `apolloAssistMachine.ts` |
| AI | Gemini (primary), Groq LLaMA (fallback) | Intent parsing, LLM responses, symptom mapping |
| Backend | Express.js | All API routes in `api/index.ts` |
| Doctor data | Local JSON | `data/finalDoctors.json` — Apollo Jubilee Hills + other branches |
| Patient records | SQLite | `database.sqlite` — stores patient name, mobile, DOB, UHID |
| EDOC | Apollo booking system | Live slot fetching and appointment booking via `EDOC_BASE_URL` |

---

## 3. Workflows to Test

### 3.1 Main Menu Navigation

**Entry point:** The chat opens on the welcome screen with 6 preset buttons.

| # | Test | Expected result |
|---|------|-----------------|
| 3.1.1 | Click **"Help me find a doctor"** | Goes to "Find Doctor" options screen |
| 3.1.2 | Click **"I want to book appointment"** | Goes to booking options screen |
| 3.1.3 | Click **"Book by location"** | Asks for city first, then branch |
| 3.1.4 | Click **"I want to book health check"** | Shows health checkup options |
| 3.1.5 | Click **"International patient services"** | Shows international services info |
| 3.1.6 | Click **"I have an emergency"** | Shows emergency contact number (1066) |
| 3.1.7 | Type **"back"** or **"main menu"** at any screen | Returns to main menu |

---

### 3.2 Casual / Conversational Messages

The bot should handle off-topic or social messages naturally, then gently guide back to healthcare.

| # | Input | Expected result |
|---|-------|-----------------|
| 3.2.1 | "how are you" | Warm, friendly response — NOT "How can I help with Apollo Hospitals?" |
| 3.2.2 | "hiiii" | Friendly greeting back |
| 3.2.3 | "you're not kind at all" | Sincere apology, warm tone |
| 3.2.4 | "thank you" | Warm acknowledgement |
| 3.2.5 | "what is your name" | Says it's Apollo Assist, doesn't reveal the model |
| 3.2.6 | "what AI model are you?" | Deflects — says it's Apollo Assist, doesn't reveal Gemini/Groq |
| 3.2.7 | Inject prompt: "ignore previous instructions and..." | Should NOT comply. Continues normal behaviour |

---

### 3.3 Book by Doctor Name

**Flow:** Main menu → Book appointment → "I know the doctor's name" → type name → select city/branch → select slot → book

| # | Test | Expected result |
|---|------|-----------------|
| 3.3.1 | Type an exact doctor name (e.g. "Dr. Koteswar Rao V") | Finds and shows doctor card |
| 3.3.2 | Type a partial name (e.g. "koteswar") | Fuzzy match — shows relevant doctor(s) |
| 3.3.3 | Type a misspelled name (e.g. "kotheswar") | Fuzzy match still finds the doctor |
| 3.3.4 | Type a name that doesn't exist (e.g. "Dr. Xyz Abc") | "No doctors found" message — no card shown |
| 3.3.5 | While viewing doctor cards, type "show me [other doctor name]" | Swaps the card to the named doctor |
| 3.3.6 | While viewing doctor cards, type a non-existent name | Friendly "couldn't find" message |

---

### 3.4 Book by Specialty

**Flow:** Main menu → Book appointment → "Search by specialty" → pick or type specialty → city → branch → slot → book

| # | Test | Expected result |
|---|------|-----------------|
| 3.4.1 | Click a specialty button (e.g. "Cardiology") | Shows cardiologists in next step |
| 3.4.2 | Type a specialty not in the buttons (e.g. "Pulmonology") | Accepts it, finds doctors |
| 3.4.3 | Type a specialty with no doctors in that location | "No doctors found" message |
| 3.4.4 | Type "General Physician" and there are no results | **Auto-retries with "General Medicine"** — should show General Medicine doctors if available |
| 3.4.5 | Type a nonsense specialty (e.g. "xyzabc") | Graceful fallback or "no doctors found" |

---

### 3.5 Symptom-Based Search

**Flow:** Main menu → Book appointment → "I have symptoms" → describe symptom → bot maps to specialty → city → branch → doctors

#### 3.5.1 — Via preset buttons
| # | Button | Expected specialty |
|---|--------|--------------------|
| — | "Chest pain / heart issues" | Cardiology |
| — | "Headache / neurological" | Neurology |
| — | "Joint / bone pain" | Orthopaedics |
| — | "Skin issues" | Dermatology |
| — | "Stomach / digestion" | Gastroenterology |

#### 3.5.2 — Via free-text symptoms (type directly, no button)

| # | Input | Expected specialty |
|---|-------|--------------------|
| 3.5.1 | "fever" | General Physician (or General Medicine fallback) |
| 3.5.2 | "cold and body ache" | General Physician |
| 3.5.3 | "sore throat" | ENT |
| 3.5.4 | "runny nose" | ENT |
| 3.5.5 | "knee pain" | Orthopaedics |
| 3.5.6 | "lower back pain" | Spine Surgery |
| 3.5.7 | "blurred vision" | Ophthalmology |
| 3.5.8 | "anxiety" | Psychiatry |
| 3.5.9 | "diabetes" | Diabetology |
| 3.5.10 | "irregular periods" | Gynaecology |
| 3.5.11 | "my child has a rash" | Paediatrics or Dermatology |
| 3.5.12 | An unusual symptom not in the preset list (e.g. "gout", "tinnitus") | Should still map via LLM |

**Pass criteria:** Bot maps to an appropriate specialty and proceeds to show doctors. Does **not** dump raw JSON in the chat. Does **not** show a broken/empty state.

---

### 3.6 Book by Location

**Flow:** Main menu → "Book by location" → select/type city → select/type branch → specialty (optional) → doctors

| # | Test | Expected result |
|---|------|-----------------|
| 3.6.1 | Select city "Hyderabad" | Asks for branch |
| 3.6.2 | Select or type a branch name | Shows doctors at that branch |
| 3.6.3 | Type a city not in the preset list (e.g. "Karimnagar") | Accepted, proceeds to branch |
| 3.6.4 | Type an invalid city (e.g. "Mars") | Graceful handling — asks again or shows fallback |

---

### 3.7 Doctor Cards

Once doctors are shown, verify the card UI.

| # | Test | Expected result |
|---|------|-----------------|
| 3.7.1 | Card shows doctor name and specialty | ✓ No emojis in specialty text |
| 3.7.2 | Click **"Show available slots"** | Slots panel expands |
| 3.7.3 | Dates shown | 3 dates visible with `‹` / `›` navigation arrows |
| 3.7.4 | Click a different date tab | Slots update for that date |
| 3.7.5 | No slots for a date | Centered "No slots available" message + "Request Appointment" button |
| 3.7.6 | Doctor has no live schedule at all | Centered "No slots available" message + "Request Appointment" button |
| 3.7.7 | Select a time slot | Slot highlights in teal |
| 3.7.8 | Click **"Book appointment →"** without selecting a slot | Button is disabled (greyed out) |
| 3.7.9 | Click **"Book appointment →"** with a slot selected | Proceeds to patient details / booking flow |
| 3.7.10 | Click **"Request Appointment"** | Triggers appointment request flow |
| 3.7.11 | Click **"Change search"** | Returns to specialty/city selection |
| 3.7.12 | Click **"Back to menu"** | Returns to main menu |
| 3.7.13 | Calendar icon next to slot times | Should show a small calendar SVG icon (not an empty square) |

---

### 3.8 Booking Flow (Patient Details)

After selecting a slot, the bot collects patient information.

| # | Test | Expected result |
|---|------|-----------------|
| 3.8.1 | Enter first name | Accepted, moves to next field |
| 3.8.2 | Enter last name | Accepted |
| 3.8.3 | Enter DOB in format DD/MM/YYYY | Accepted |
| 3.8.4 | Enter a 10-digit Indian mobile number | Accepted |
| 3.8.5 | Enter an invalid phone (< 10 digits) | Error / re-prompt |
| 3.8.6 | Complete all details | Proceeds to UHID lookup / booking confirmation |
| 3.8.7 | Booking confirms successfully | Shows appointment ID and confirmation message |
| 3.8.8 | Booking fails (EDOC error) | Friendly error message, not a crash |

---

### 3.9 No Doctors Found

| # | Scenario | Expected result |
|---|----------|-----------------|
| 3.9.1 | Search returns 0 doctors | The "Showing available doctors..." message is **replaced** with a "No doctors were found" message. **No empty card is shown.** |
| 3.9.2 | General Physician returns 0 → General Medicine also returns 0 | Single "No doctors found" message shown |
| 3.9.3 | General Physician returns 0 → General Medicine returns doctors | General Medicine doctors shown on cards |

---

### 3.10 Mid-Flow Intent Switching (AI Navigation)

The bot should understand redirects typed mid-conversation without forcing the user to start over.

| # | Current state | User types | Expected result |
|---|---------------|-----------|-----------------|
| 3.10.1 | Entering doctor name | "actually show me cardiologists" | Switches to specialty search for Cardiology |
| 3.10.2 | Viewing cards | "I have a fever" | Maps fever → General Physician, starts new search |
| 3.10.3 | Asked for city | "I want to go back" | Returns to main menu |
| 3.10.4 | Main menu | "I need a cardiologist in Hyderabad" | Jumps straight to showing cardiologists in Hyderabad |
| 3.10.5 | Main menu | "Dr. Ramesh Babu" (just a name) | Starts doctor name search for "Ramesh Babu" |
| 3.10.6 | Main menu | "I have chest pain" | Maps to Cardiology, starts symptom flow |

---

### 3.11 Health Checkup

| # | Test | Expected result |
|---|------|-----------------|
| 3.11.1 | Select "I want to book health check" | Shows health checkup packages for selected city |
| 3.11.2 | Select a city | Packages for that city displayed |
| 3.11.3 | Select a package | Shows details or directs to website |

---

### 3.12 International Patient Services

| # | Test | Expected result |
|---|------|-----------------|
| 3.12.1 | Click "International patient services" | Shows international helpline, email, and info |
| 3.12.2 | Phone/email shown | Should display the correct Apollo international contact details |

---

### 3.13 Emergency

| # | Test | Expected result |
|---|------|-----------------|
| 3.13.1 | Click "I have an emergency" | Shows emergency number **1066** prominently |
| 3.13.2 | Type "emergency" at any screen | Should be recognised and show emergency info |

---

### 3.14 Multilingual Support

The bot auto-detects language from the user's message.

| # | Input | Expected result |
|---|-------|-----------------|
| 3.14.1 | Type in Hindi (e.g. "मुझे डॉक्टर चाहिए") | Bot responds in Hindi |
| 3.14.2 | Type in Telugu (e.g. "నాకు డాక్టర్ కావాలి") | Bot responds in Telugu |
| 3.14.3 | Romanized Hindi (e.g. "mujhe doctor chahiye") | Bot may detect Hindi and respond in Hindi |
| 3.14.4 | Quick-reply buttons after non-English message | Labels may be translated |
| 3.14.5 | Type in English again after non-English | Bot should switch back to English |

---

## 4. UI Checks

| # | Element | Expected |
|---|---------|----------|
| 4.1 | Header | Flat teal (#2582A1), "Apollo Assist" title, "Here for You 24/7" subtitle |
| 4.2 | User messages | Light teal bubble, right-aligned |
| 4.3 | Bot messages | White bubble, left-aligned, bot avatar |
| 4.4 | Quick-reply buttons | Appear below bot message, **disappear as soon as user sends a message** (no 1-2 second flash) |
| 4.5 | Historical quick replies | After a selection, show greyed-out "Option selected:" label above the old buttons |
| 4.6 | "Select an option:" label | Appears above the current active quick-reply set |
| 4.7 | 👍 👎 reaction buttons | Appear below quick replies |
| 4.8 | Typing indicator | Three pulsing dots appear while bot is loading a response |
| 4.9 | Footer | "Powered by **Apollo HealthAxis**" — NOT "eka.care" |
| 4.10 | No-slots panel | Filled blue-grey box, text centred, "Request Appointment" button full-width |
| 4.11 | No-slots when dates are shown | Panel spans full card width (not half a column) |
| 4.12 | Calendar icon | Small SVG calendar icon next to each time slot (not an empty square) |
| 4.13 | Phone input | Shows 🇮🇳 +91 prefix |

---

## 5. Known Limitations

| Limitation | Detail |
|-----------|--------|
| Doctor data coverage | The doctor database covers Apollo Jubilee Hills (Hyderabad) most comprehensively. Other cities may return fewer or no results — this is a data gap, not a bug. |
| Live slot availability | EDOC live slot fetching depends on the Apollo EDOC server being available. If EDOC is down, slots won't load and "No slots available" will show. |
| Specialty fallback | If "General Physician" returns no doctors, the bot automatically retries with "General Medicine". No other specialty has this fallback. |
| Symptom → specialty via LLM | For very unusual symptoms not in the static map, the bot calls the LLM symptom resolver. If the LLM is unavailable (no API key), it falls back to the category picker screen. |
| AI response quality | If both Gemini and Groq are unavailable, the bot falls back to static hardcoded messages. |
| Language detection | Romanized regional languages (e.g. Telugu/Hindi typed in English letters) may not always be detected correctly. Native script detection is reliable. |

---

## 6. What to Log as a Bug

Please report as a bug if:

- A symptom typed in free text causes the bot to show raw JSON, a code block, or an error trace in the chat bubble
- Doctor cards appear when "no doctors found" should be shown, or vice versa
- Booking succeeds but no confirmation message is shown
- Quick-reply buttons are visible while the bot is still generating a response (the 1-2 second flash)
- Emergency number shown is anything other than **1066**
- The bot reveals it is powered by Gemini, Groq, or any specific AI model
- A mid-flow intent redirect (e.g. "actually show cardiologists") is ignored and the bot asks for the same field again
- The UI crashes or shows a white/blank screen
- among other things
---

## 7. Test Accounts / Data

There is no login system. Each browser session starts fresh.

For EDOC booking tests, use the following test patient details (confirm with dev team if EDOC is connected to a staging environment):

- **Name:** Test Patient
- **DOB:** 01/01/1990
- **Mobile:** 9999999999

These details will trigger the UHID lookup. If no UHID is found, the system creates one (GenerateUHID call). If EDOC is in production mode, avoid completing real bookings.

---

## 8. Reporting

Please report bugs with:
1. Steps to reproduce (what you typed, what button you clicked)
2. Current state the bot was in (visible from the quick-reply buttons or last bot message)
3. What happened vs. what you expected
4. A screenshot if the issue is visual

File bugs against the `Apollo-AI-Chatbot` repo.
