import { Router, Request, Response } from "express";
import { getSession } from "../services/chatSessionService";
import { getPatientByPhone } from "../services/patientService";
import { getAppointmentsForPatient } from "../services/appointmentService";
import { generalLimiter } from "../middleware/rateLimit.middleware";
import { isValidSessionId } from "../middleware/session.middleware";
import log from "../lib/logger";

export const sessionRouter = Router();

// ── GET /api/session/:sessionId ───────────────────────────────────────────────
// Returns chat session history for page-refresh restoration.
sessionRouter.get(
  "/session/:sessionId",
  generalLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
      res.status(400).json({ error: "sessionId required", messages: [] });
      return;
    }
    if (req.sessionId !== sessionId) {
      res.status(403).json({ error: "Session access denied", messages: [] });
      return;
    }
    try {
      const session = await getSession(sessionId, 100);
      if (!session) {
        res.status(404).json({ sessionId, messages: [] });
        return;
      }
      res.json({
        sessionId: session.sessionId,
        language:  session.language,
        messages:  session.messages.map((m) => ({
          role:         m.role,
          message:      m.message,
          messageType:  m.messageType,
          buttonLabel:  m.buttonLabel,
          buttonValue:  m.buttonValue,
          machineState: m.machineState,
          createdAt:    m.createdAt,
        })),
      });
    } catch (err) {
      log.error({ err }, "GET /api/session/:sessionId error");
      res.status(500).json({ error: "Failed to load session", messages: [] });
    }
  },
);

// ── POST /api/appointments/check ──────────────────────────────────────────────
// Returns the most recent confirmed appointment for a patient+doctor pair.
// Used by the frontend to show a duplicate-booking warning.
sessionRouter.post(
  "/appointments/check",
  async (req: Request, res: Response): Promise<void> => {
    if (req.sessionId === "anonymous") {
      res.status(401).json({ error: "X-Session-Id required", existing: null });
      return;
    }
    const { phone, doctorName } = req.body as Record<string, string>;
    const normalizedPhone = String(phone ?? "").replace(/[^0-9+]/g, "");
    if (!normalizedPhone || !doctorName || !/^\+?[0-9]{10,13}$/.test(normalizedPhone)) {
      res.status(400).json({ error: "phone and doctorName required", existing: null });
      return;
    }
    try {
      const patient = await getPatientByPhone(normalizedPhone);
      if (!patient) {
        res.json({ existing: null });
        return;
      }
      const appointments = await getAppointmentsForPatient(patient.id);
      const normalizedTarget = doctorName.toLowerCase().replace(/^dr\.?\s*/i, "").trim();
      const match = appointments.find((a) => {
        const normalizedAppt = a.doctorName.toLowerCase().replace(/^dr\.?\s*/i, "").trim();
        return normalizedAppt === normalizedTarget && a.status === "confirmed";
      });
      if (!match) {
        res.json({ existing: null });
        return;
      }
      res.json({
        existing: {
          apptId:     match.edocAppointmentId ?? match.id,
          doctorName: match.doctorName,
          date:       match.appointmentDate,
          time:       match.slotTime,
          status:     match.status,
        },
      });
    } catch (err) {
      const e = err as { message?: string };
      log.error({ err }, "POST /api/appointments/check error");
      res.json({ existing: null, warning: e.message });
    }
  },
);
