/**
 * backend/providers/compositePatientProvider.ts
 *
 * Composite (Apollo-first, Prisma-fallback) implementation of PatientProvider.
 *
 * Strategy per operation:
 *   getPatientByPhone  → try EDOC; on any failure fall back to Prisma
 *   createPatient      → try EDOC; on any failure fall back to Prisma
 *   setUhid            → always delegates to Prisma (EDOC owns UHIDs, no update needed there)
 *
 * Fallback triggers:
 *   - EDOC not configured (env vars missing)
 *   - axios timeout / network error
 *   - EDOC non-0 retcode / unexpected response shape
 *   - any thrown exception from the primary provider
 *
 * Architecture rules enforced here:
 *   - Local Prisma is FALLBACK ONLY — never auto-synced to EDOC
 *   - chatbot/business logic never knows which provider was used
 *   - All routing decisions are logged as audit events
 */

import type { PatientProvider, PatientRecord, CreatePatientInput, ProviderMetadata } from "./PatientProvider";
import { apolloEdocPatientProvider } from "./apolloEdocPatientProvider";
import { prismaPatientProvider } from "./prismaPatientProvider";
import { logEvent } from "../services/auditService";

// Session ID is not meaningful at the provider layer; use a fixed sentinel for
// audit events that originate here rather than from an HTTP request.
const PROVIDER_SESSION = "system:composite-provider";

/** Classify the thrown error for structured logging. */
function classifyError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message.includes("timeout") || err.message.includes("ETIMEDOUT")) return "edoc_timeout";
    if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) return "edoc_unavailable";
    if (err.message.includes("not configured")) return "edoc_not_configured";
    if (err.message.includes("whitelist") || err.message.includes("401") || err.message.includes("403")) return "edoc_whitelist_blocked";
    return "edoc_api_failure";
  }
  return "edoc_unknown_error";
}

/** Fire-and-forget audit event with provider metadata. */
function auditProviderEvent(
  operation: string,
  meta: ProviderMetadata,
  extra?: Record<string, unknown>
): void {
  void logEvent(PROVIDER_SESSION, `patient_provider.${operation}`, {
    provider:       meta.provider,
    fallbackUsed:   meta.fallbackUsed,
    fallbackReason: meta.fallbackReason ?? null,
    ...extra,
  }).catch(() => {});
}

export const compositePatientProvider: PatientProvider = {
  providerName: "apollo_edoc", // reports primary intent; fallback is an implementation detail

  // ─────────────────────────────────────────────────────────────────────────
  async getPatientByPhone(phoneNumber: string): Promise<PatientRecord | null> {
    // 1. Try EDOC first
    try {
      const patient = await apolloEdocPatientProvider.getPatientByPhone(phoneNumber);
      auditProviderEvent("getPatientByPhone", { provider: "apollo_edoc", fallbackUsed: false }, { phoneNumber });
      return patient;
    } catch (primaryErr) {
      const reason = classifyError(primaryErr);
      console.warn(`[CompositeProvider] EDOC getPatientByPhone failed (${reason}), falling back to Prisma`);

      auditProviderEvent("getPatientByPhone", {
        provider:       "prisma_local",
        fallbackUsed:   true,
        fallbackReason: reason,
      }, { phoneNumber, error: String(primaryErr) });

      // 2. Fallback to Prisma
      return prismaPatientProvider.getPatientByPhone(phoneNumber);
    }
  },

  // ─────────────────────────────────────────────────────────────────────────
  async createPatient(input: CreatePatientInput): Promise<PatientRecord> {
    // 1. Try EDOC first
    try {
      const patient = await apolloEdocPatientProvider.createPatient(input);
      auditProviderEvent("createPatient", { provider: "apollo_edoc", fallbackUsed: false }, {
        phoneNumber: input.phoneNumber,
      });

      // Also persist locally so future lookups get a cache hit even if EDOC is down
      void prismaPatientProvider.createPatient({
        phoneNumber: input.phoneNumber,
        fullName:    input.fullName,
        dob:         input.dob,
        uhid:        patient.uhid ?? undefined,
      }).catch(() => {}); // non-fatal — local is fallback, not source of truth

      return patient;
    } catch (primaryErr) {
      const reason = classifyError(primaryErr);
      console.warn(`[CompositeProvider] EDOC createPatient failed (${reason}), falling back to Prisma`);

      auditProviderEvent("createPatient", {
        provider:       "prisma_local",
        fallbackUsed:   true,
        fallbackReason: reason,
      }, { phoneNumber: input.phoneNumber, error: String(primaryErr) });

      // 2. Fallback to Prisma
      return prismaPatientProvider.createPatient(input);
    }
  },

  // ─────────────────────────────────────────────────────────────────────────
  async setUhid(patientId: string, uhid: string): Promise<PatientRecord> {
    // EDOC owns UHIDs — only update local Prisma record
    auditProviderEvent("setUhid", { provider: "prisma_local", fallbackUsed: false }, { patientId, uhid });
    return prismaPatientProvider.setUhid(patientId, uhid);
  },
};
