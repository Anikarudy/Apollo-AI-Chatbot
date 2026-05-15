# Apollo AI Chatbot — Architecture Snapshot
> Captured: 15 May 2026. Use this as the baseline before further refactoring.

---

## Table of Contents
1. [Frontend Architecture](#1-frontend-architecture)
2. [Backend Architecture](#2-backend-architecture)
3. [XState Workflow](#3-xstate-workflow)
4. [Gemini Orchestration](#4-gemini-orchestration)
5. [Fuse.js Retrieval](#5-fusejs-retrieval)
6. [EDOC Integration](#6-edoc-integration)
7. [Postgres / Hasura](#7-postgres--hasura)
8. [Session Handling](#8-session-handling)
9. [Logging](#9-logging)
10. [Known Issues](#10-known-issues)
11. [Production Risks](#11-production-risks)
12. [Remaining Work](#12-remaining-work)

---

## 1. Frontend Architecture

### Stack
| Concern | Choice |
|---|---|
| Framework | React 19, TypeScript, Vite |
| State machine | XState v5 (via `useChatMachine` hook) |
| Styling | Plain CSS (`ChatWidget.css`) |
| Entry point | `src/main.tsx` → `src/App.tsx` → `src/components/ChatWidget.tsx` |

### Component tree
```
App.tsx                    — thin wrapper, fills 100 vh (designed for iframe embed)
└── ChatWidget.tsx         — all chat UI: messages, doctor cards, slots, input bar
    └── useChatMachine.ts  — React hook bridging XState + all API calls
```

### `ChatWidget.tsx` responsibilities
- Renders the message list and auto-scrolls on new messages.
- Renders inline **doctor cards** anchored to the bot message that triggered them.
  Each card shows: name, specialty, hospital, "Show available slots" toggle, date tabs,
  time slot grid, and a Book / Request Appointment button.
- Quick-reply chips (translated when user language ≠ English).
- Thumbs-up / thumbs-down reaction buttons on bot messages (UI only — not yet wired).
- Rate limit banner: amber toast with live countdown when a 429 is received.
- Input bar: disabled + placeholder "Please wait…" during rate limiting.

### `useChatMachine.ts` responsibilities
- Creates/reuses a `sessionIdRef` (UUID from `localStorage`, sent as `X-Session-Id`).
- Drives the XState machine (`ApolloAssistRunner`) and mirrors its state/context into React state.
- Decides per-turn whether to:
  1. Run silent (static state transitions — no API call)
  2. Call `/api/agent/decide` (AI orchestration)
  3. Call `/api/chat` (Gemini free-text response)
  4. Call `/api/intent` (legacy intent classifier fallback)
- Fetches calendar dates and slots for every doctor card via background `useEffect`.
- Manages multilingual state: detects script (`detectScriptLanguage`), calls `/api/detect-language`,
  translates quick replies and bot messages via `/api/translate-ui`.
- Maintains a rolling `conversationSummary` (injected into `/api/chat` as LLM memory).
- Exposes `rateLimitSeconds` (set on 429 from `/api/chat` or `/api/agent/decide`).

---

## 2. Backend Architecture

### Runtime
```
NODE_OPTIONS=--use-system-ca ts-node --project tsconfig.server.json api/index.ts
```
Single Express 5 process, no worker threads, no job queue.

### Middleware stack (in order)
| Layer | Package | Purpose |
|---|---|---|
| Security headers | `helmet` | Blocks XSS, clickjacking, MIME sniffing, etc. |
| CORS | `cors` | Allows requests from `FRONTEND_ORIGIN` only |
| Body parsing | `express.json` | 64 KB limit |
| General rate limit | `express-rate-limit` | 120 req/min fallback on all routes |
| Request logger | pino `res.on("finish")` | Logs method, path, status, latency |
| Session ID | custom middleware | Reads `X-Session-Id` header → `req.sessionId` |

### Route inventory
| Route | Limiter | Purpose |
|---|---|---|
| `POST /api/chat` | chatLimiter (50/min) | Gemini free-text response |
| `POST /api/agent/decide` | chatLimiter (50/min) | LLM orchestration decision |
| `POST /api/intent` | intentLimiter (80/min) | Legacy intent classifier |
| `POST /api/detect-language` | intentLimiter | ISO 639-1 language detection |
| `POST /api/translate-ui` | — | UI string translation |
| `POST /api/summarize` | — | Conversation summarisation |
| `POST /api/symptom-specialty` | — | Symptom → specialty mapping |
| `GET  /api/doctors` | — | Fuzzy doctor name lookup |
| `POST /api/agent/query` | — | All-branch doctor search (Gemini tool calling) |
| `POST /api/agent/book-appointment` | — | Booking orchestration wrapper |
| `POST /api/edoc/book-appointment` | bookingLimiter (5/min) | EDOC BookAppointment |
| `POST /api/edoc/reschedule-appointment` | bookingLimiter | EDOC ResheduleAppointment |
| `POST /api/edoc/cancel-appointment` | bookingLimiter | EDOC CancelAppointment |
| `POST /api/edoc/slots` | calendarLimiter (30/min) | EDOC DoctorCalenderRules |
| `POST /api/edoc/slots-v2` | calendarLimiter | EDOC DoctorCalenderRules_V2 |
| `POST /api/edoc/calendar-dates` | calendarLimiter | EDOC DoctorCalenderLiveDates |
| `POST /api/edoc/calendar-details` | calendarLimiter | EDOC DoctorCalenderDetails |
| `POST /api/edoc/uhid-search` | — | EDOC patient lookup by UHID |
| `POST /api/edoc/generate-uhid` | — | EDOC GenerateUHIDOnline |
| `POST /api/doctor-search` | — | Gemini tool-calling doctor search |
| `POST /api/patient/lookup` | — | Hasura patient lookup |
| `POST /api/patient/register` | — | Hasura patient registration |
| `GET  /health` | — | Liveness probe |

### Rate limiter 429 response shape
```json
{ "error": "Too many requests", "retryAfter": 15, "message": "Please wait 15 seconds..." }
```
The `retryAfter` field is consumed by the frontend countdown timer.

### AI providers
- **Google Gemini** (`@google/generative-ai`) — primary LLM for chat, orchestration, doctor search, translation.
- **Groq** (`groq-sdk`) — available as a fallback model (configured but not all routes use it).

---

## 3. XState Workflow

### Machine file
`apolloAssistMachine.ts` — XState v5 `createMachine` + `createActor`.

### Context shape (`ApolloContext`)
Carries all session state: `doctorName`, `specialty`, `city`, `branch`, `symptomText`,
`phoneNumber`, `resourceId`, `locationId`, `regionId`, `serviceId`, `uhid`,
`appointmentId`, `selectedDate`, `selectedSlotStart/End`, `patientFirstName/LastName/Dob`.

### State catalogue (67 states)
**Entry / Menu:** `WELCOME`, `MAIN_MENU`, `AI_PREFILL_ROUTE`

**Doctor search:**
`BOOK_APPT_OPTIONS`, `FIND_DOCTOR_OPTIONS`, `ENTER_DOCTOR_NAME`, `PROCESS_DOCTOR_NAME`,
`SEARCH_DOCTOR`, `DOCTOR_NAME_SUGGESTIONS`, `DOCTOR_FOUND`, `SELECT_SPECIALTY`,
`PROCESS_SPECIALTY`, `SEARCH_BY_SPECIALTY_STATE`, `SPECIALTY_FOUND`, `ASK_CITY`,
`ASK_BRANCH`, `SEARCH_DOCTORS_BY_CRITERIA`, `DOCTORS_FOUND`, `DOCTOR_NOT_FOUND`,
`DOCTOR_NOT_FOUND_ASK_CITY`, `SPECIALTY_NOT_FOUND`, `SHOW_DOCTORS`

**Symptom flow:**
`ASK_BASIC_DETAILS`, `SELECT_SYMPTOM_CATEGORY`, `PROCESS_SYMPTOM_CATEGORY`,
`SELECT_SYMPTOM_DETAIL`, `PROCESS_SYMPTOM_DETAIL`, `MAP_TO_SPECIALTY`, `SHOW_SPECIALTY_RESULT`

**Booking flow:**
`BOOK_APPT_OPTIONS_LOCATION`, `ASK_CITY_FOR_LOCATION`, `ASK_BRANCH_FOR_LOCATION`,
`CONFIRM_BOOKING`, `ENTER_PHONE_FOR_BOOKING`, `PROCESS_UHID`, `COLLECT_PATIENT_DETAILS`,
`GENERATE_UHID_STATE`, `UHID_GENERATE_FAILED`, `CONFIRM_APPOINTMENT`, `PROCESS_BOOKING`,
`BOOKING_FAILED_STATE`, `BOOKING_CONFIRMED`

**Reschedule / Cancel:**
`RESCHEDULE_APPOINTMENT`, `PROCESS_RESCHEDULE`, `RESCHEDULE_FAILED_STATE`,
`CANCEL_APPOINTMENT_STATE`, `PROCESS_CANCEL`, `CANCEL_FAILED_STATE`

**Health checkup:** `HEALTH_CHECKUP_ENTRY`, `SHOW_PACKAGES`, `REDIRECT_TO_WEBSITE`

**International / Contact:** `ASK_DETAILS`, `CHECK_MISSING_DETAILS`, `ASK_SPECIFIC_DETAIL`,
`HANDLE_REFUSAL`, `PROVIDE_CONTACT_DETAILS`, `CONFIRM_SUBMISSION`, `SUBMIT_REQUEST`,
`SUBMISSION_SUCCESS`, `PROVIDE_CONTACT_NUMBER`

**Utility:** `ENTER_PHONE`, `VERIFY_OTP`, `BOOKING_SUCCESS`, `SHOW_EMERGENCY_MESSAGE`,
`FALLBACK`, `END`

### AI bypass strategy
`NO_LLM_STATES` — 25 transient/loading/error states that never call Gemini.
`AGENT_DECIDE_STATES` — 22 states where `/api/agent/decide` runs on every free-text turn.
`AI_NAV_STATES` — 6 menu/fallback states that use the legacy intent classifier as backup.

---

## 4. Gemini Orchestration

### `/api/agent/decide` — orchestration router
- Called on every user free-text turn from `AGENT_DECIDE_STATES`.
- Sends: current XState state, machine context, user message, rolling history (last 10 turns), conversation summary, user language.
- LLM returns a structured `AgentDecision`:
  ```typescript
  {
    action: "CONTINUE_WORKFLOW" | "SWITCH_WORKFLOW" | "CALL_TOOL" | "ASK_CLARIFICATION" | "RESET_FLOW",
    targetWorkflow: string | null,
    confidence: number,
    entities: { doctorName, specialty, city, branch, symptomText }
  }
  ```
- The hook (`executeAgentDecision`) maps the decision to XState events and/or doctor lookups.

### `/api/chat` — free-text response generator
- Called after state transitions where a natural-language bot reply is needed.
- Sends: user message, current state, machine context, conversation summary, rolling history.
- Returns `{ text: string }` — rendered directly as the bot message.

### `/api/doctor-search` — tool-calling search
- Sends a `searchDoctors` function declaration to Gemini with `FunctionCallingMode.ANY`.
- Gemini emits a tool call → server executes `searchDoctors()` locally → feeds result back to Gemini → returns grounded `{ text, doctors[] }`.

### `/api/translate-ui` / `/api/detect-language`
- Gemini translates quick-reply chips and bot messages on demand.
- Heuristic script detection (`detectScriptLanguage`) fires instantly; API call only when heuristic returns null.
- Translation results are cached per `lang:labels` key to avoid duplicate calls.

---

## 5. Fuse.js Retrieval

### Data source
`data/finalDoctors.json` — 6,303 doctor records (`doctorName`, `resourceId`, `regionId`, `city`, `branch`, `location`, `speciality`).

### Knowledge base (`src/knowledgeBase.ts`)
- Loads `finalDoctors.json` + `data/jubileeDoctors.json` at startup.
- Enriches each record: resolves `locationId` from `BRANCH_LOCATION_MAP` if not present in raw data.
- Deduplicates by `name|resourceId|locationId|regionId`.
- 5,337 of 6,303 records resolve a `locationId` (the rest lack a recognised branch string).
- Exports: `doctors[]`, `allCities[]`, `specialities[]`, `hospitalsByCity`, `getDoctorsByName()`,
  `getDoctorsForLocation()`, `mapSymptomToSpecialty()`, `buildDoctorSearchUrl()`.

### `api/searchDoctors.ts`
- Fuse.js index with weights: name 0.55, specialty 0.25, city 0.10, branch 0.10.
- Threshold 0.35 (lenient fuzzy), `ignoreLocation: true`.
- `searchDoctors(query, city?, branch?, limit?)` — used by Gemini tool calling.
- `fuzzySearchAllDoctors()` — used by `/api/doctors?name=` for free-text doctor lookup.

### Location mapping (`data/locationMap.ts`)
`BRANCH_LOCATION_MAP` — 40+ branch → `{ locationId, regionId }` entries covering:
Hyderabad, Delhi/NCR, Kolkata, Chennai, Lucknow, Visakhapatnam, Kakinada, Karimnagar,
Nashik, Indore, Bangalore, and others.

---

## 6. EDOC Integration

EDOC is Apollo's hospital booking backend. All calls are **server-side only** — the browser never touches EDOC directly.

### Configuration (`.env`)
```
APOLLO_EDOC_BASE_URL=https://pgcdcuat.apollo.net.in:7176   # UAT — active
APOLLO_EDOC_AUTH_KEY=<uuid>
```
Auth is sent as a custom HTTP header: `AuthKey: <uuid>` (not `Authorization: Bearer`).

### EDOC endpoints proxied
| Internal route | EDOC endpoint | Notes |
|---|---|---|
| `/api/edoc/calendar-dates` | `DoctorCalenderLiveDates` | Returns comma-separated `D/M/YYYY` strings |
| `/api/edoc/slots` | `DoctorCalenderRules` | Returns time slots for a date |
| `/api/edoc/slots-v2` | `DoctorCalenderRules_V2` | Returns slots + serviceId per slot |
| `/api/edoc/calendar-details` | `DoctorCalenderDetails` | Syncs calendar before slot fetch |
| `/api/edoc/book-appointment` | `BookAppointment` | Returns `AppointmentID` on success |
| `/api/edoc/reschedule-appointment` | `ResheduleAppointment` | |
| `/api/edoc/cancel-appointment` | `CancelAppointment` | |
| `/api/edoc/uhid-search` | (UHID lookup) | |
| `/api/edoc/generate-uhid` | `GenerateUHIDOnline` | Creates new patient in EDOC |

### Location resolution strategy
`getLocationCandidates()` in `api/index.ts` builds a priority-ordered list of `locationId` values to try:
1. City-name lookup from `locationIdsByCity`
2. Passed `locationId` (if numeric)
3. Doctor's `resourceId` (fallback for unmapped branches)

The `/api/edoc/calendar-dates` endpoint iterates through candidates and returns the first non-empty response.

### Date format conversions
- EDOC sends: `D/M/YYYY` (e.g. `"1/7/2025"`)
- EDOC accepts: `DD-MON-YYYY` (e.g. `"01-JUL-2025"`)
- Frontend `LiveDate` carries both formats plus `label` (day name) and `month` (3-letter).

### Calendar loading flow (frontend)
1. `useEffect` fires whenever `doctorCards` changes.
2. For each card with `resourceId` + `locationId`, calls `/api/edoc/calendar-dates`.
3. Tries alternate `resourceIds` if the primary returns zero dates.
4. Auto-loads slots for the first available date via `/api/edoc/slots-v2` (falls back to `/api/edoc/slots`).
5. Calls `/api/edoc/calendar-details` before slot fetch (sync call; failure is silently swallowed).
6. Results stored in `liveDates[doctorKey]` and `liveSlots[slotKey]`.

---

## 7. Postgres / Hasura

### Provider abstraction
All persistence goes through four service interfaces (`api/services/interfaces.ts`):
- `IPatientService` — `findPatient()`, `registerPatient()`
- `IAppointmentService` — `saveAppointment()`
- `IChatService` — `upsertSession()`, `logMessage()`
- `IAuditService` — `logEvent()`

Concrete implementations live in `api/services/hasura/`. SQLite bridge providers exist in `api/services/sqlite/` and `api/services/null/` but are commented out in `providers.ts`.

### Hasura providers (active)
| File | GraphQL operations |
|---|---|
| `hasuraPatientProvider.ts` | `GET_PATIENT_BY_MOBILE`, `INSERT_PATIENT` |
| `hasuraAppointmentProvider.ts` | `INSERT_APPOINTMENT` |
| `hasuraChatProvider.ts` | `UPSERT_SESSION`, `GET_SESSION_UUID`, `INSERT_MESSAGE` |
| `hasuraAuditProvider.ts` | `INSERT_AUDIT_EVENT` |

### UUID handling
`chat_messages.session_id` is a `uuid` FK in Postgres — not plain text. `HasuraChatProvider` maintains a `uuidCache: Map<string, string>` (session string → Hasura UUID) to avoid extra round-trips on every message insert.

### Configuration (`.env`)
```
HASURA_GRAPHQL_ENDPOINT=https://<your-hasura-cloud-url>/v1/graphql
HASURA_ADMIN_SECRET=<secret>
```

### Chat logging pattern
All `logMessage()` calls are fire-and-forget:
```typescript
void chatService.logMessage(...).catch(() => {});
```
This means logging failures never crash the request — but are also silently lost.

---

## 8. Session Handling

### Browser session
- On first load, `getOrCreateSessionId()` calls `crypto.randomUUID()` and stores it in `localStorage("apollo_session_id")`.
- Persists across page refreshes; cleared only if the user clears localStorage.
- Sent as the `X-Session-Id` request header on every API call.

### Server session
- Express middleware reads `X-Session-Id` and attaches it to `req.sessionId`.
- No server-side session store — the ID is passed through to Hasura as a reference only.
- No expiry or invalidation logic exists yet.

### Conversation summary (in-memory "long-term memory")
- `conversationSummaryRef` in `useChatMachine` accumulates a rolling plain-text summary.
- Updated on: doctors shown, doctor selected, booking confirmed, appointment requested.
- Injected into every `/api/chat` call as `summary:` field so Gemini has context beyond the last 10 turns.
- Cleared when user returns to `MAIN_MENU`.

---

## 9. Logging

### Backend — pino
- Structured JSON logger; `pino-pretty` in development (`NODE_ENV !== "production"`).
- Log level controlled by `LOG_LEVEL` env var (default `"info"`).
- Every request logs: `method`, `path`, `status`, `ms` on `res.finish`.
- Status ≥ 500 → `log.error`, ≥ 400 → `log.warn`, otherwise `log.info`.
- EDOC calls have verbose inline logging via `logEdoc(step, payload)` helper (always `console.info` — not pino).
- Agent/decide logs: action, targetWorkflow, confidence to `console.log` (not pino).

### Frontend — console
- `logEdoc()` in `useChatMachine` logs every EDOC request/response to `console.info`.
- No structured frontend logging or error reporting service (e.g. Sentry) connected.

---

## 10. Known Issues

| # | Issue | Impact | Location |
|---|---|---|---|
| 1 | **Duplicate `.env` entry** for `APOLLO_EDOC_BASE_URL` (line 17 vs line 41) caused the dead `edoc.apollohospitals.com` hostname to override the working UAT URL. Fixed by commenting out line 41, but the comment is fragile — a future env regeneration could re-introduce it. | Calendar dates show "Request Appointment" for all doctors | `.env` |
| 2 | **EDOC UAT data sparsity** — UAT server (`pgcdcuat.apollo.net.in`) returns `retcode: -2 / Internal Error` for many doctors. Production data may differ. | Calendar dates empty for most doctors even on correct URL | EDOC UAT |
| 3 | **`getAuditService()` imported but never called** anywhere — audit trail is effectively non-functional. | No audit log written | `api/services/providers.ts` |
| 4 | **`/api/patient/lookup` and `/api/patient/register`** routes exist but the main booking flow still passes patient data directly to EDOC without going through `IPatientService`. | Hasura patient table not populated from booking flow | `api/index.ts` lines ~1718–1780 |
| 5 | **`upsertSession()` never called explicitly** — sessions are only created lazily inside `logMessage()` on the first chat message. If the user abandons before sending a message, no session row is written. | Incomplete session records | `hasuraChatProvider.ts` |
| 6 | **Thumbs-up / thumbs-down reaction buttons** render in the UI but emit no event and call no API. | Dead UI elements | `ChatWidget.tsx` |
| 7 | **EDOC `logEdoc()` helper uses `console.info`** instead of the pino `log` instance. EDOC logs are not structured JSON in production. | EDOC debug output not captured by log aggregators | `api/index.ts` |
| 8 | **`/api/agent/decide` and `/api/agent/query` use `console.log`/`console.warn`** instead of pino. | Inconsistent log format | `api/index.ts` |
| 9 | **No retry or circuit-breaker** on EDOC calls. A slow EDOC response blocks the 15-second Axios timeout per candidate locationId. With 3 candidates that's 45 seconds before fallback. | UI appears frozen during EDOC outages | `api/index.ts` EDOC routes |
| 10 | **`messagesRef` used before declaration** — `useEffect(() => { messagesRef.current = messages; })` references `messagesRef` which is declared after it in the hook. Works at runtime due to hoisting but is fragile. | Potential stale ref in edge cases | `useChatMachine.ts` |

---

## 11. Production Risks

| Risk | Severity | Notes |
|---|---|---|
| **Single process, no clustering** | High | One crashed ts-node process takes down the entire API. Use `pm2 cluster` or move to a container with restart policy. |
| **No HTTPS enforcement** | High | `helmet` sets headers but the server itself listens on plain HTTP. TLS must be terminated at a reverse proxy (nginx/ALB). |
| **`HASURA_ADMIN_SECRET` in env** | High | Any server-side code injection or env leak exposes full Hasura admin access. Restrict to a row-level-security role in production. |
| **`APOLLO_EDOC_AUTH_KEY` in env** | High | Key is a static UUID with no rotation. Compromise gives full EDOC booking access. |
| **No input sanitisation on EDOC params** | Medium | `resourceId`, `locationId`, `regionId` are passed from request body to Axios without validation beyond a basic numeric check for `locationId`. |
| **Fire-and-forget Hasura logs** | Medium | `.catch(() => {})` silently discards all Hasura write failures. Silent data loss in persistence layer. |
| **No health check on Hasura/EDOC** | Medium | `/health` endpoint exists but only confirms Express is alive — it does not probe Hasura or EDOC connectivity. |
| **CORS `FRONTEND_ORIGIN` is a single string** | Medium | Comma-separated multi-origin is mentioned in comments but not implemented — `cors({ origin: string })` only allows one origin. |
| **Rate limiting is per-process** | Medium | `express-rate-limit` uses in-memory counters. With multiple instances, limits are per-instance, not global. Needs Redis store for production clustering. |
| **No request ID propagation** | Low | Pino logs have no `requestId` field correlating a single user turn across multiple log lines. |
| **`better-sqlite3` in `dependencies`** | Low | SQLite is unused (providers commented out) but the native module is still compiled and included in the bundle. |

---

## 12. Remaining Work

### High priority
- [ ] **Wire `IPatientService` into the booking flow** — `/api/edoc/book-appointment` should call `getPatientService().findPatient()` or `registerPatient()` and write the result to Hasura before calling EDOC.
- [ ] **Call `upsertSession()` on first API request** — create the Hasura session row at the start of the conversation, not lazily on first message.
- [ ] **Implement `IAuditService` calls** — log sensitive actions (booking, cancellation, patient registration) to the audit table.
- [ ] **Replace EDOC `console.info` / agent `console.log` with pino** — unify all server logs as structured JSON.

### Medium priority
- [ ] **Wire reaction buttons** — thumbs-up/down should POST to a `/api/feedback` endpoint and write to Hasura.
- [ ] **Multi-origin CORS** — parse `FRONTEND_ORIGIN` as comma-separated array and pass `origin: string[]` to `cors()`.
- [ ] **EDOC circuit breaker / timeout reduction** — add `p-circuit-breaker` or equivalent; reduce per-candidate timeout from 15s to 5s.
- [ ] **Redis-backed rate limiting** — replace in-memory `express-rate-limit` store with `rate-limit-redis` for multi-instance safety.
- [ ] **Add `requestId` to pino logs** — generate a UUID per request and include it in every log line for correlation.
- [ ] **`/health` deep check** — probe Hasura (`/healthz`) and EDOC reachability and return `503` if either is down.

### Low priority / hygiene
- [ ] Remove `better-sqlite3` from `dependencies` (move to `optionalDependencies` or remove entirely if SQLite path is retired).
- [ ] Fix `messagesRef` declaration order in `useChatMachine.ts`.
- [ ] Add `eslint` + `prettier` config — currently no linter is configured.
- [ ] Add at least smoke-level integration tests (`scripts/smokeAgentQuery.js` exists but `npm test` is a no-op).
- [ ] Move `HASURA_ADMIN_SECRET` access to a least-privilege Hasura role with row-level security.
- [ ] Document the Hasura schema (tables: `patients`, `appointments`, `chat_sessions`, `chat_messages`, `audit_events`).
