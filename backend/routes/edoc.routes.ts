import { Router, Request, Response } from "express";
import axios from "axios";
import { doctors } from "../../frontend/src/knowledgeBase";
import { bookingLimiter, calendarLimiter } from "../middleware/rateLimit.middleware";
import { requireEdoc, logEdoc, EDOC_BASE, edocHeaders } from "../lib/edocConfig";
import {
  isNumericLocationId,
  getLocationCandidates,
  resolveRegionId,
  toEdocDate,
  isFakeSchedule,
} from "../lib/edocHelpers";
import { edocPost, isSafeFailure } from "../infra/edocClient";
import { logEvent } from "../services/auditService";
import { getOrCreatePatient, setPatientUhid, getPatientByPhone } from "../services/patientService";
import { createAppointment, updateAppointmentStatusByEdocId } from "../services/appointmentService";
import operationalPrisma from "../db/operationalPrismaClient";
import log from "../lib/logger";

export const edocRouter = Router();

// ── POST /api/edoc/book-appointment ──────────────────────────────────────────
// Booking with idempotency guard + EDOC resilience layer.
edocRouter.post("/book-appointment", bookingLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.ResourceID || !b.StartDateTime || !b.LocationID || !b.UHIDNumber) {
    res.status(400).json({ error: "ResourceID, StartDateTime, LocationID, UHIDNumber required" });
    return;
  }
  if (!isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }

  // ── Idempotency key ──────────────────────────────────────────────────────────
  const bookingRequestId = String(b.bookingRequestId ?? "").trim();
  const startDt          = String(b.StartDateTime ?? "");
  const [appointmentDate = "", slotTimeFull = ""] = startDt.split(" ");
  const slotTime         = slotTimeFull.substring(0, 5);
  const phone            = String(b.MobileNumber ?? "").replace(/[^0-9+]/g, "");
  const matchedDoctor    = doctors.find((d) => String(d.resourceId) === String(b.ResourceID));
  const doctorName       = matchedDoctor?.name ?? String(b.ResourceID);

  if (bookingRequestId) {
    // ── CASE A: duplicate check ────────────────────────────────────────────────
    const existing = await operationalPrisma.bookingRequest
      .findUnique({ where: { bookingRequestId } })
      .catch(() => null);

    if (existing) {
      if (existing.status === "processing") {
        res.status(202).json({
          idempotent: true,
          status: "processing",
          message: "Booking is already being processed. Please wait.",
        });
        return;
      }
      void logEvent(req.sessionId, "booking_duplicate_prevented", {
        bookingRequestId,
        status: existing.status,
      }).catch(() => {});

      log.info({ bookingRequestId, status: existing.status }, "[Idempotency] hit — returning stored response");
      const stored = existing.responsePayload as Record<string, unknown> | null;
      if (existing.status === "success" && stored) {
        res.json({ ...stored, idempotent: true });
      } else {
        res.status(500).json({
          ...((stored as Record<string, unknown>) ?? {}),
          idempotent: true,
          error: "Previous booking attempt failed",
        });
      }
      return;
    }

    // ── CASE B: new request — create processing record ─────────────────────────
    await operationalPrisma.bookingRequest
      .create({
        data: {
          bookingRequestId,
          sessionId:      req.sessionId,
          patientPhone:   phone || "unknown",
          doctorName,
          appointmentDate,
          slotTime,
          status:         "processing",
        },
      })
      .catch((err: unknown) =>
        log.error({ err }, "[Idempotency] failed to create BookingRequest row"),
      );
  }

  // ── Call EDOC via resilient client ───────────────────────────────────────────
  try {
    const edocData = await edocPost<Record<string, unknown>>(
      "/api/EDOC/BookAppointment",
      b,
      req.sessionId,
    );

    if (isSafeFailure(edocData)) {
      if (bookingRequestId) {
        await operationalPrisma.bookingRequest
          .update({
            where: { bookingRequestId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data:  { status: "failed", responsePayload: edocData as any },
          })
          .catch(() => {});
      }
      void logEvent(req.sessionId, "booking_failure", {
        bookingRequestId,
        reason:        "edoc_exhausted",
        resourceId:    b.ResourceID,
        startDateTime: b.StartDateTime,
      }).catch(() => {});
      res.status(503).json(edocData);
      return;
    }

    log.info({ appointmentId: edocData.AppointmentID }, "[EDOC] BookAppointment succeeded");

    void logEvent(req.sessionId, "booking_success", {
      bookingRequestId,
      appointmentId: edocData.AppointmentID,
      resourceId:    b.ResourceID,
      locationId:    b.LocationID,
      uhid:          b.UHIDNumber,
      startDateTime: b.StartDateTime,
    }).catch(() => {});

    if (bookingRequestId) {
      await operationalPrisma.bookingRequest
        .update({
          where: { bookingRequestId },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data:  { status: "success", responsePayload: edocData as any },
        })
        .catch(() => {});
    }

    if (phone) {
      void (async () => {
        try {
          const firstName = String(b.FirstName ?? "").trim();
          const lastName  = String(b.LastName ?? "").trim();
          const fullName  = [firstName, lastName].filter(Boolean).join(" ") || "Unknown";
          const uhid      = String(b.UHIDNumber ?? "").trim() || undefined;
          const patient   = await getOrCreatePatient({ phoneNumber: phone, fullName, dob: "", uhid });
          await createAppointment({
            patientId:         patient.id,
            doctorName:        matchedDoctor?.name ?? String(b.ResourceID),
            specialty:         matchedDoctor?.speciality,
            hospital:          matchedDoctor?.branch,
            appointmentDate,
            slotTime,
            edocAppointmentId:
              edocData.AppointmentID !== undefined ? String(edocData.AppointmentID) : undefined,
          });
        } catch (opErr) {
          console.error("[Operational] Failed to persist appointment:", opErr);
        }
      })();
    }

    res.json(edocData);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    if (bookingRequestId) {
      await operationalPrisma.bookingRequest
        .update({
          where: { bookingRequestId },
          data:  { status: "failed", responsePayload: { error: String(e.message ?? "unknown") } },
        })
        .catch(() => {});
    }
    void logEvent(req.sessionId, "booking_failure", {
      bookingRequestId,
      error:         String(e.message ?? "unknown"),
      resourceId:    b.ResourceID,
      locationId:    b.LocationID,
      startDateTime: b.StartDateTime,
    }).catch(() => {});
    res.status(500).json({ error: e.response?.data ?? e.message ?? "BookAppointment failed" });
  }
});

// ── POST /api/edoc/reschedule-appointment ─────────────────────────────────────
edocRouter.post("/reschedule-appointment", bookingLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.AppointmentID || !b.StartDateTime) {
    res.status(400).json({ error: "AppointmentID and StartDateTime required" });
    return;
  }
  if (b.LocationID !== undefined && b.LocationID !== null && !isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }
  try {
    const r = await axios.post(
      `${EDOC_BASE}/api/EDOC/ResheduleAppointment`,
      b,
      { headers: edocHeaders(), timeout: 15000 },
    );
    console.log("[EDOC] ResheduleAppointment succeeded (200 OK)");
    const edocData = r.data as Record<string, unknown>;

    void (async () => {
      try {
        const oldEdocId = String(b.AppointmentID);
        const oldRow = await updateAppointmentStatusByEdocId(oldEdocId, "cancelled");
        if (oldRow) {
          const startDt = String(b.StartDateTime ?? "");
          const [newDate = "", newSlotFull = ""] = startDt.split(" ");
          const newSlot = newSlotFull.substring(0, 5);
          await createAppointment({
            patientId:         oldRow.patientId,
            doctorName:        oldRow.doctorName,
            specialty:         oldRow.specialty ?? undefined,
            hospital:          oldRow.hospital ?? undefined,
            appointmentDate:   newDate,
            slotTime:          newSlot,
            edocAppointmentId:
              edocData.AppointmentID !== undefined ? String(edocData.AppointmentID) : oldEdocId,
          });
        }
      } catch (opErr) {
        console.error("[Operational] Failed to update rescheduled appointment:", opErr);
      }
    })();

    res.json(r.data);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    res.status(500).json({ error: e.response?.data ?? e.message ?? "ResheduleAppointment failed" });
  }
});

// ── POST /api/edoc/cancel-appointment ────────────────────────────────────────
edocRouter.post("/cancel-appointment", bookingLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.AppointmentID || !b.LocationID) {
    res.status(400).json({ error: "AppointmentID and LocationID required" });
    return;
  }
  if (!isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }
  try {
    const r = await axios.post(
      `${EDOC_BASE}/api/EDOC/CancelAppointment`,
      b,
      { headers: edocHeaders(), timeout: 15000 },
    );
    console.log("[EDOC] CancelAppointment succeeded (200 OK)");
    void updateAppointmentStatusByEdocId(String(b.AppointmentID), "cancelled").catch((err) =>
      console.error("[Operational] Failed to update cancelled status:", err),
    );
    res.json(r.data);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    res.status(500).json({ error: e.response?.data ?? e.message ?? "CancelAppointment failed" });
  }
});

// ── POST /api/edoc/slots ──────────────────────────────────────────────────────
edocRouter.post("/slots", calendarLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, date, city, branch } = req.body as Record<string, string>;
  if (!resourceId || !date) {
    res.status(400).json({ error: "resourceId and date required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({ slots: [], retcode: -1, error: "No valid locationId available" });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        logEdoc("DoctorCalenderRules.request", {
          resourceId, locationId: locId, regionId: resolveRegionId(branch, regionId), date,
        });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/DoctorCalenderRules`,
          { RegionID: resolveRegionId(branch, regionId), Locationid: locId, ResourceID: resourceId, ID_Date: date },
          { headers: edocHeaders(), timeout: 15000 },
        );
        logEdoc("DoctorCalenderRules.response", r.data);
        const raw =
          (r.data as { getDoctorCalenderRulesDetails?: string; retcode?: number })
            .getDoctorCalenderRulesDetails ?? "";
        const allRawSlots = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (isFakeSchedule(allRawSlots)) {
          logEdoc("DoctorCalenderRules.fake_schedule", {
            resourceId, locationId: locId, slotsCount: allRawSlots.length, firstSlot: allRawSlots[0],
          });
          lastError = "fake schedule";
          continue;
        }
        const slots = allRawSlots.filter((s) => s >= "07:00" && s <= "21:00");
        res.status(200).json({ slots, retcode: (r.data as { retcode?: number }).retcode ?? 0, locationId: locId });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("DoctorCalenderRules.error", { message: ie.message, resourceId, locationId: locId, date });
        lastError = ie.message ?? "DoctorCalenderRules failed";
      }
    }
    res.status(200).json({ slots: [], retcode: -1, error: lastError || "DoctorCalenderRules failed" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({ error: e.message ?? "DoctorCalenderRules failed", slots: [], retcode: -1 });
  }
});

// ── POST /api/edoc/slots-v2 ───────────────────────────────────────────────────
edocRouter.post("/slots-v2", calendarLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, date, city, branch } = req.body as Record<string, string>;
  if (!resourceId || !date) {
    res.status(400).json({ error: "resourceId and date required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({ services: [], allSlots: [], slotToServiceId: {}, defaultServiceId: null, retcode: -1, error: "No valid locationId available" });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        logEdoc("DoctorCalenderRules_V2.request", {
          resourceId, locationId: locId, regionId: resolveRegionId(branch, regionId), date,
        });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/DoctorCalenderRules_V2`,
          { RegionID: resolveRegionId(branch, regionId), Locationid: locId, ResourceID: resourceId, ID_Date: date },
          { headers: edocHeaders(), timeout: 15000 },
        );
        logEdoc("DoctorCalenderRules_V2.response", r.data);

        const body = r.data as {
          getDoctorNewRulesDetails?: Array<{
            serviceid?: string | number;
            servicedetail?: Array<{
              requestdate?: string; starttime?: string; endtime?: string;
              slotinterval?: string | number; maxslot?: string | number; split_slots?: string;
            }>;
          }>;
          retcode?: number;
          Message?: string | null;
        };

        const serviceRows = Array.isArray(body.getDoctorNewRulesDetails)
          ? body.getDoctorNewRulesDetails
          : [];
        const services = serviceRows
          .map((row) => {
            const serviceId = String(row.serviceid ?? "").trim();
            const details = Array.isArray(row.servicedetail) ? row.servicedetail : [];
            const slotSet = new Set<string>();
            details.forEach((d) => {
              String(d.split_slots ?? "").split(",").forEach((v) => {
                const slot = v.trim();
                if (slot) slotSet.add(slot);
              });
            });
            return {
              serviceId,
              requestDate:  String(details[0]?.requestdate ?? "").trim(),
              startTime:    String(details[0]?.starttime ?? "").trim(),
              endTime:      String(details[0]?.endtime ?? "").trim(),
              slotInterval: String(details[0]?.slotinterval ?? "").trim(),
              maxSlot:      String(details[0]?.maxslot ?? "").trim(),
              slots:        Array.from(slotSet),
            };
          })
          .filter((row) => row.serviceId.length > 0);

        const slotToServiceId: Record<string, string> = {};
        const allSlotsSet = new Set<string>();
        services.forEach((service) => {
          service.slots.forEach((slot) => {
            allSlotsSet.add(slot);
            if (!slotToServiceId[slot]) slotToServiceId[slot] = service.serviceId;
          });
        });

        const isReasonableSlot = (t: string) => t >= "07:00" && t <= "21:00";
        const allSlots = Array.from(allSlotsSet).filter(isReasonableSlot).sort((a, b) => a.localeCompare(b));

        if (isFakeSchedule(Array.from(allSlotsSet))) {
          logEdoc("DoctorCalenderRules_V2.fake_schedule", {
            resourceId, locationId: locId, slotsCount: allSlotsSet.size, firstSlot: Array.from(allSlotsSet).sort()[0],
          });
          lastError = "fake schedule";
          continue;
        }
        res.status(200).json({
          services, allSlots, slotToServiceId,
          defaultServiceId: services[0]?.serviceId ?? null,
          retcode:   body.retcode ?? 0,
          locationId: locId,
          message:   body.Message ?? null,
        });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("DoctorCalenderRules_V2.error", { message: ie.message, resourceId, locationId: locId, date });
        lastError = ie.message ?? "DoctorCalenderRules_V2 failed";
      }
    }
    res.status(200).json({ services: [], allSlots: [], slotToServiceId: {}, defaultServiceId: null, retcode: -1, error: lastError || "DoctorCalenderRules_V2 failed" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({ services: [], allSlots: [], slotToServiceId: {}, defaultServiceId: null, retcode: -1, error: e.message ?? "DoctorCalenderRules_V2 failed" });
  }
});

// ── POST /api/edoc/calendar-details ──────────────────────────────────────────
edocRouter.post("/calendar-details", calendarLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, date, city, branch } = req.body as Record<string, string>;
  if (!resourceId) {
    res.status(400).json({ error: "resourceId required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({ calendar: [], retcode: -1, error: "No valid locationId available" });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        const xmlReq = `<ResourceDetails><Resource ResourceID = '${resourceId}' LocationID='${locId}' /></ResourceDetails>`;
        logEdoc("GetCalendardetailsforOnline.request", {
          resourceId, locationId: locId, regionId: resolveRegionId(branch, regionId), date: date ?? "",
        });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/GetCalendardetailsforOnline`,
          { ixmlcalendarrequest: xmlReq, ID_Date: date ?? "", RegionID: resolveRegionId(branch, regionId) },
          { headers: edocHeaders(), timeout: 15000 },
        );
        logEdoc("GetCalendardetailsforOnline.response", r.data);
        const body = r.data as { getCalendarList?: unknown[]; retcode?: number; Message?: string | null };
        const calendar = Array.isArray(body.getCalendarList) ? body.getCalendarList : [];
        res.status(200).json({ calendar, retcode: body.retcode ?? 0, locationId: locId, message: body.Message ?? null });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("GetCalendardetailsforOnline.error", { message: ie.message, resourceId, locationId: locId, date });
        lastError = ie.message ?? "GetCalendardetailsforOnline failed";
      }
    }
    res.status(200).json({ calendar: [], retcode: -1, error: lastError || "GetCalendardetailsforOnline failed" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({ calendar: [], retcode: -1, error: e.message ?? "GetCalendardetailsforOnline failed" });
  }
});

// ── POST /api/edoc/uhid-search ────────────────────────────────────────────────
edocRouter.post("/uhid-search", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { phone, regionId, uhidNumber } = req.body as Record<string, string>;
  const normalizedPhone = String(phone ?? "").replace(/[^0-9+]/g, "");
  if (!normalizedPhone) {
    res.status(400).json({ error: "phone required" });
    return;
  }
  if (!/^\+?[0-9]{10,13}$/.test(normalizedPhone)) {
    res.status(400).json({ error: "Invalid phone number format" });
    return;
  }

  // Local DB first: avoid unnecessary EDOC round-trip
  try {
    const localPatient = await getPatientByPhone(normalizedPhone);
    if (localPatient?.uhid) {
      console.log(`[UHID] Cache hit for ${normalizedPhone} → ${localPatient.uhid}`);
      res.json({ uhidList: [{ UHIDNumber: localPatient.uhid }], retcode: 0, source: "local" });
      return;
    }
  } catch (localErr) {
    console.error("[UHID] Local patient lookup failed, falling back to EDOC:", localErr);
  }

  try {
    const r = await axios.post(
      `${EDOC_BASE}/api/EDOC/GetUHID`,
      { MobileNumber: normalizedPhone, RegionID: Number(regionId ?? "5"), UHIDNumber: uhidNumber ?? "" },
      { headers: edocHeaders(), timeout: 15000 },
    );
    const data = r.data as { getUHIDList?: unknown[]; retcode?: number };
    res.json({ uhidList: data.getUHIDList ?? [], retcode: data.retcode ?? 0 });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(500).json({ error: e.message ?? "GetUHID failed", uhidList: [] });
  }
});

// ── POST /api/edoc/calendar-dates ─────────────────────────────────────────────
edocRouter.post("/calendar-dates", calendarLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const { resourceId, locationId, regionId, city, branch } = req.body as Record<string, string>;
  if (!resourceId) {
    res.status(400).json({ error: "resourceId required" });
    return;
  }

  const locationCandidates = getLocationCandidates(city, locationId, resourceId, branch);
  if (locationCandidates.length === 0) {
    res.status(200).json({ dates: [], retcode: -1, error: "No valid locationId available" });
    return;
  }

  try {
    let lastError = "";
    for (const locId of locationCandidates) {
      try {
        logEdoc("DoctorCalenderLiveDates.request", {
          resourceId, locationId: locId, regionId: resolveRegionId(branch, regionId),
        });
        const r = await axios.post(
          `${EDOC_BASE}/api/EDOC/DoctorCalenderLiveDates`,
          { RegionID: resolveRegionId(branch, regionId), Locationid: locId, ResourceID: resourceId },
          { headers: edocHeaders(), timeout: 15000 },
        );
        logEdoc("DoctorCalenderLiveDates.response", r.data);
        const raw = (r.data as { Dates?: string; retcode?: number }).Dates ?? "";
        const retcode = (r.data as { retcode?: number }).retcode ?? 0;
        const dates = raw
          ? raw
              .split(",")
              .map((d) => ({ display: d.trim(), edoc: toEdocDate(d.trim()) }))
              .slice(0, 30)
          : [];
        if (dates.length === 0) {
          logEdoc("DoctorCalenderLiveDates.no_live_dates", {
            resourceId,
            requestedLocationId: locationId ?? null,
            resolvedLocationId:  locId,
            regionId:            resolveRegionId(branch, regionId),
            city:                city ?? null,
            retcode,
            rawDates:            raw,
            reason:              "EDOC returned empty Dates",
          });
        }
        res.status(200).json({ dates, retcode, locationId: locId });
        return;
      } catch (innerErr: unknown) {
        const ie = innerErr as { message?: string };
        logEdoc("DoctorCalenderLiveDates.error", { message: ie.message, resourceId, locationId: locId });
        lastError = ie.message ?? "DoctorCalenderLiveDates failed";
      }
    }
    res.status(200).json({ dates: [], retcode: -1, error: lastError || "DoctorCalenderLiveDates failed" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(200).json({ error: e.message ?? "DoctorCalenderLiveDates failed", dates: [], retcode: -1 });
  }
});

// ── POST /api/edoc/generate-uhid ──────────────────────────────────────────────
edocRouter.post("/generate-uhid", async (req: Request, res: Response): Promise<void> => {
  if (!requireEdoc(res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.FirstName || !b.MobileNumber || !b.LocationID) {
    res.status(400).json({ error: "FirstName, MobileNumber, LocationID required" });
    return;
  }
  if (!isNumericLocationId(b.LocationID)) {
    res.status(400).json({ error: "LocationID must be numeric" });
    return;
  }
  try {
    const r = await axios.post(
      `${EDOC_BASE}/api/EDOC/GenerateUHIDOnline`,
      b,
      { headers: edocHeaders(), timeout: 15000 },
    );
    const data = r.data as { result?: string; retcode?: number };
    const uhid = data.result ?? "";

    if (uhid) {
      const phone = String(b.MobileNumber ?? "").replace(/[^0-9+]/g, "");
      if (phone) {
        void (async () => {
          try {
            const firstName = String(b.FirstName ?? "").trim();
            const lastName  = String(b.LastName ?? "").trim();
            const fullName  = [firstName, lastName].filter(Boolean).join(" ") || "Unknown";
            const dob       = String(b.DateOfBirth ?? "").trim();
            const patient   = await getOrCreatePatient({ phoneNumber: phone, fullName, dob, uhid });
            if (!patient.uhid) {
              await setPatientUhid(patient.id, uhid);
            }
          } catch (opErr) {
            console.error("[Operational] Failed to persist patient from generate-uhid:", opErr);
          }
        })();
      }
    }

    res.json({ uhid, retcode: data.retcode ?? 0 });
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data: unknown } };
    res.status(500).json({ error: e.response?.data ?? e.message ?? "GenerateUHIDOnline failed" });
  }
});
