import { Router, Request, Response } from "express";
import { generalLimiter } from "../middleware/rateLimit.middleware";
import { isValidSessionId } from "../middleware/session.middleware";
import { getPatientByPhone } from "../services/patientService";

export const toolRouter = Router();

interface OtpChallenge {
  challengeId: string;
  sessionId: string;
  mobileNumber: string;
  otpCode: string;
  expiresAt: number;
  attempts: number;
  leadDescription?: string;
}

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const challenges = new Map<string, OtpChallenge>();

function maskMobile(phone: string): string {
  const value = phone.replace(/\D/g, "");
  if (value.length < 4) return "****";
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function normalizePhone(input: string): string {
  const digits = input.replace(/[^0-9]/g, "");
  return digits.length === 10 ? digits : input.replace(/[^0-9+]/g, "");
}

function currentOtpBySession(sessionId: string): OtpChallenge | null {
  const now = Date.now();
  for (const challenge of challenges.values()) {
    if (challenge.sessionId === sessionId && challenge.expiresAt > now) {
      return challenge;
    }
  }
  return null;
}

async function fetchUhidOptions(phone: string): Promise<Array<{ uhid: string; fullName?: string; dob?: string }>> {
  try {
    const patient = await getPatientByPhone(phone);
    if (!patient?.uhid) return [];
    return [{
      uhid: patient.uhid,
      fullName: patient.fullName,
      dob: patient.dob,
    }];
  } catch {
    return [];
  }
}

// POST /api/tools/mobile-verification
// Stage machine: mobile -> otp -> uhid

toolRouter.post("/tools/mobile-verification", generalLimiter, async (req: Request, res: Response): Promise<void> => {
  if (req.sessionId === "anonymous" || !isValidSessionId(req.sessionId)) {
    res.status(401).json({
      error_code: "user_not_authenticated",
      error_message: "Missing or invalid session",
    });
    return;
  }

  const params = ((req.body ?? {}) as { tool_params?: Record<string, unknown> }).tool_params ?? {};
  const stage = String(params.stage ?? "").toLowerCase();

  if (stage === "mobile") {
    const rawMobile = String(params.mobile_number ?? "").trim();
    const mobileNumber = normalizePhone(rawMobile);
    if (!/^\+?[0-9]{10,13}$/.test(mobileNumber)) {
      res.status(400).json({
        error_code: "invalid_mobile_number",
        error_message: "Please provide a valid mobile number",
      });
      return;
    }

    const challengeId = crypto.randomUUID();
    const otpCode = `${Math.floor(100000 + Math.random() * 900000)}`;
    challenges.set(challengeId, {
      challengeId,
      sessionId: req.sessionId,
      mobileNumber,
      otpCode,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      leadDescription: typeof params.lead_description === "string" ? params.lead_description : undefined,
    });

    const isDev = process.env.NODE_ENV !== "production";
    res.json({
      status: "otp_sent",
      challenge_id: challengeId,
      masked_mobile: maskMobile(mobileNumber),
      ttl_seconds: Math.floor(OTP_TTL_MS / 1000),
      ...(isDev ? { debug_otp: otpCode } : {}),
    });
    return;
  }

  if (stage === "otp") {
    const challengeId = String(params.challenge_id ?? "").trim();
    const otp = String(params.otp ?? "").trim();
    const challenge = challengeId ? challenges.get(challengeId) : currentOtpBySession(req.sessionId);

    if (!challenge || challenge.sessionId !== req.sessionId || challenge.expiresAt < Date.now()) {
      res.status(400).json({
        error_code: "otp_not_found",
        error_message: "OTP session expired. Please request a new OTP.",
      });
      return;
    }

    challenge.attempts += 1;
    if (challenge.attempts > MAX_OTP_ATTEMPTS) {
      challenges.delete(challenge.challengeId);
      res.status(400).json({
        error_code: "otp_not_found",
        error_message: "OTP expired due to too many attempts.",
      });
      return;
    }

    const bypassOtp = String(process.env.OTP_BYPASS ?? "false").toLowerCase() === "true";
    const valid = bypassOtp || otp === challenge.otpCode;
    if (!valid) {
      res.status(400).json({
        error_code: "invalid_otp",
        error_message: "Invalid OTP",
      });
      return;
    }

    const uhidOptions = await fetchUhidOptions(challenge.mobileNumber);
    if (uhidOptions.length > 1) {
      res.json({
        status: "otp_verified",
        challenge_id: challenge.challengeId,
        uhid_options: uhidOptions,
      });
      return;
    }

    if (uhidOptions.length === 1) {
      challenges.delete(challenge.challengeId);
      res.json({
        status: "uhid_selected",
        selected_uhid: uhidOptions[0].uhid,
      });
      return;
    }

    // No UHID found; still mark verification successful and let flow proceed.
    challenges.delete(challenge.challengeId);
    res.json({
      status: "otp_verified",
      uhid_options: [],
    });
    return;
  }

  if (stage === "uhid") {
    const selectedUhid = String(params.selected_uhid ?? "").trim();
    const challengeId = String(params.challenge_id ?? "").trim();
    const challenge = challengeId ? challenges.get(challengeId) : currentOtpBySession(req.sessionId);

    if (!selectedUhid || !challenge || challenge.sessionId !== req.sessionId) {
      res.status(400).json({
        error_code: "invalid_uhid",
        error_message: "Invalid UHID selection",
      });
      return;
    }

    const options = await fetchUhidOptions(challenge.mobileNumber);
    const isValid = options.some((option) => option.uhid === selectedUhid);
    if (!isValid) {
      res.status(400).json({
        error_code: "invalid_uhid",
        error_message: "UHID not found in current OTP session",
      });
      return;
    }

    challenges.delete(challenge.challengeId);
    res.json({
      status: "uhid_selected",
      selected_uhid: selectedUhid,
    });
    return;
  }

  res.status(400).json({
    error_code: "tool_error",
    error_message: "Unsupported mobile verification stage",
  });
});
