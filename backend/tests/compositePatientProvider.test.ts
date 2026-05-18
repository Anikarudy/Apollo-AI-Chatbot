/**
 * backend/tests/compositePatientProvider.test.ts
 *
 * Tests for CompositePatientProvider covering the 5 required scenarios:
 *
 *  1. EDOC success           → Apollo provider used, no fallback
 *  2. EDOC timeout           → Prisma fallback triggered
 *  3. Neither finds patient  → createPatient local flow
 *  4. AuditEvent logs provider + fallback metadata
 *  5. Booking flow continues regardless of provider used
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mock axios before any provider imports ────────────────────────────────────
vi.mock("axios");
import axios from "axios";

// ── Mock auditService so DB is never touched ──────────────────────────────────
vi.mock("../services/auditService", () => ({
  logEvent: vi.fn().mockResolvedValue(null),
}));
import { logEvent } from "../services/auditService";

// ── Mock prismaPatientProvider ────────────────────────────────────────────────
vi.mock("../providers/prismaPatientProvider", () => ({
  prismaPatientProvider: {
    providerName: "prisma_local",
    getPatientByPhone: vi.fn(),
    createPatient:     vi.fn(),
    setUhid:           vi.fn(),
  },
}));
import { prismaPatientProvider } from "../providers/prismaPatientProvider";

// Import the composite AFTER all mocks are set up
import { compositePatientProvider } from "../providers/compositePatientProvider";

// ── Helpers ───────────────────────────────────────────────────────────────────
const MOCK_EDOC_PATIENT = {
  id:          "APJ1.9999999",
  phoneNumber: "9876543210",
  fullName:    "Test Patient",
  dob:         "01-Jan-1990",
  uhid:        "APJ1.9999999",
  createdAt:   new Date(),
  updatedAt:   new Date(),
};

const MOCK_LOCAL_PATIENT = {
  id:          "uuid-local-1234",
  phoneNumber: "9876543210",
  fullName:    "Test Patient",
  dob:         "01-Jan-1990",
  uhid:        "APJ1.LOCAL",
  createdAt:   new Date(),
  updatedAt:   new Date(),
};

const EDOC_SUCCESS_RESPONSE = {
  data: {
    getUHIDList: [
      { UHIDNumber: "APJ1.9999999", FirstName: "Test", LastName: "Patient", DateOfBirth: "01-Jan-1990" },
    ],
    retcode: 0,
  },
};

function setEdocEnv() {
  process.env.APOLLO_EDOC_BASE_URL  = "http://edoc.test";
  process.env.APOLLO_EDOC_AUTH_KEY  = "test-auth-key";
  process.env.APOLLO_EDOC_DEFAULT_REGION   = "5";
  process.env.APOLLO_EDOC_DEFAULT_LOCATION = "LOC001";
}

function clearEdocEnv() {
  delete process.env.APOLLO_EDOC_BASE_URL;
  delete process.env.APOLLO_EDOC_AUTH_KEY;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("CompositePatientProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEdocEnv();
  });

  // ── Test 1: EDOC success ────────────────────────────────────────────────────
  it("Test 1 — EDOC success: Apollo provider used, no Prisma fallback", async () => {
    (axios.post as Mock).mockResolvedValueOnce(EDOC_SUCCESS_RESPONSE);

    const result = await compositePatientProvider.getPatientByPhone("9876543210");

    expect(result).not.toBeNull();
    expect(result?.uhid).toBe("APJ1.9999999");
    expect(result?.fullName).toBe("Test Patient");

    // Prisma must NOT have been called
    expect(prismaPatientProvider.getPatientByPhone).not.toHaveBeenCalled();

    // Audit event must record apollo_edoc, no fallback
    expect(logEvent).toHaveBeenCalledWith(
      expect.any(String),
      "patient_provider.getPatientByPhone",
      expect.objectContaining({ provider: "apollo_edoc", fallbackUsed: false })
    );
  });

  // ── Test 2: EDOC timeout ────────────────────────────────────────────────────
  it("Test 2 — EDOC timeout: Prisma fallback triggered", async () => {
    const timeoutError = new Error("timeout of 10000ms exceeded");
    (axios.post as Mock).mockRejectedValueOnce(timeoutError);
    (prismaPatientProvider.getPatientByPhone as Mock).mockResolvedValueOnce(MOCK_LOCAL_PATIENT);

    const result = await compositePatientProvider.getPatientByPhone("9876543210");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("uuid-local-1234");

    // Prisma WAS called as fallback
    expect(prismaPatientProvider.getPatientByPhone).toHaveBeenCalledWith("9876543210");

    // Audit event records fallback
    expect(logEvent).toHaveBeenCalledWith(
      expect.any(String),
      "patient_provider.getPatientByPhone",
      expect.objectContaining({
        provider:       "prisma_local",
        fallbackUsed:   true,
        fallbackReason: "edoc_timeout",
      })
    );
  });

  // ── Test 3: Neither source finds patient → createPatient local flow ─────────
  it("Test 3 — Neither source finds patient: createPatient uses local fallback", async () => {
    // getPatientByPhone: EDOC fails, Prisma returns null (unknown patient)
    const networkError = new Error("ECONNREFUSED");
    (axios.post as Mock).mockRejectedValueOnce(networkError);
    (prismaPatientProvider.getPatientByPhone as Mock).mockResolvedValueOnce(null);

    const found = await compositePatientProvider.getPatientByPhone("9876543210");
    expect(found).toBeNull();

    // createPatient: EDOC also fails, Prisma creates a local record
    (axios.post as Mock).mockRejectedValueOnce(networkError);
    (prismaPatientProvider.createPatient as Mock).mockResolvedValueOnce(MOCK_LOCAL_PATIENT);

    const created = await compositePatientProvider.createPatient({
      phoneNumber: "9876543210",
      fullName:    "Test Patient",
      dob:         "01-Jan-1990",
    });

    expect(created).not.toBeNull();
    expect(created.id).toBe("uuid-local-1234");
    expect(prismaPatientProvider.createPatient).toHaveBeenCalled();
  });

  // ── Test 4: Audit events carry provider + fallback metadata ────────────────
  it("Test 4 — Audit events include provider and fallback metadata", async () => {
    // Simulate EDOC whitelist block (403-style error)
    const blockedError = new Error("Request failed with status 403 whitelist");
    (axios.post as Mock).mockRejectedValueOnce(blockedError);
    (prismaPatientProvider.getPatientByPhone as Mock).mockResolvedValueOnce(MOCK_LOCAL_PATIENT);

    await compositePatientProvider.getPatientByPhone("9876543210");

    expect(logEvent).toHaveBeenCalledWith(
      expect.any(String),
      "patient_provider.getPatientByPhone",
      expect.objectContaining({
        provider:       "prisma_local",
        fallbackUsed:   true,
        fallbackReason: "edoc_whitelist_blocked",
        phoneNumber:    "9876543210",
      })
    );
  });

  // ── Test 5: Booking flow continues regardless of which provider was used ────
  it("Test 5 — Booking flow continues regardless of provider", async () => {
    // Case A: EDOC succeeds
    (axios.post as Mock).mockResolvedValueOnce(EDOC_SUCCESS_RESPONSE);
    const fromEdoc = await compositePatientProvider.getPatientByPhone("9876543210");
    expect(fromEdoc?.uhid).toBeTruthy();

    // Case B: EDOC fails, Prisma provides the patient
    (axios.post as Mock).mockRejectedValueOnce(new Error("EDOC unavailable"));
    (prismaPatientProvider.getPatientByPhone as Mock).mockResolvedValueOnce(MOCK_LOCAL_PATIENT);
    const fromPrisma = await compositePatientProvider.getPatientByPhone("9876543210");
    expect(fromPrisma?.uhid).toBeTruthy();

    // In both cases the caller receives a valid PatientRecord — booking can proceed
    expect(fromEdoc).not.toBeNull();
    expect(fromPrisma).not.toBeNull();
  });
});
