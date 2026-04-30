export interface AgentDoctor {
  name: string;
  specialty?: string;
  hospital?: string;
  resourceId?: string;
  resourceIds?: string[];
  locationId?: string;
  regionId?: string;
  serviceId?: string;
}

export interface AgentLiveDate {
  display: string;
  edoc: string;
}

export interface AgentSlots {
  slots: string[];
  serviceBySlot: Record<string, string>;
  defaultServiceId: string | null;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

export function mapDoctorsForAgent(raw: unknown): { doctors: AgentDoctor[]; source?: string; url?: string } {
  const payload = raw as { doctors?: unknown[]; source?: string; url?: string };
  const doctors = (payload.doctors ?? [])
    .map((row) => {
      const d = row as Record<string, unknown>;
      const resourceIds = Array.from(
        new Set(
          (Array.isArray(d.resourceIds) ? d.resourceIds : [])
            .map((value) => asString(value))
            .filter((value) => value.length > 0)
        )
      );

      const doctor: AgentDoctor = {
        name: asString(d.name),
        specialty: asString(d.specialty) || undefined,
        hospital: asString(d.hospital) || undefined,
        resourceId: asString(d.resourceId) || undefined,
        resourceIds: resourceIds.length > 0 ? resourceIds : undefined,
        locationId: asString(d.locationId) || undefined,
        regionId: asString(d.regionId) || undefined,
        serviceId: asString(d.serviceId) || undefined,
      };

      return doctor;
    })
    .filter((d) => d.name.length > 0);

  return {
    doctors,
    source: payload.source,
    url: payload.url,
  };
}

export function mapCalendarDatesForAgent(raw: unknown): {
  dates: AgentLiveDate[];
  locationId?: string;
  retcode?: number;
  error?: string;
} {
  const payload = raw as { dates?: unknown[]; locationId?: string; retcode?: number; error?: string };
  const dates = (payload.dates ?? [])
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        display: asString(r.display),
        edoc: asString(r.edoc),
      };
    })
    .filter((d) => d.display.length > 0 && d.edoc.length > 0);

  return {
    dates,
    locationId: asString(payload.locationId) || undefined,
    retcode: payload.retcode,
    error: asString(payload.error) || undefined,
  };
}

export function mapSlotsForAgent(raw: unknown): AgentSlots {
  const payload = raw as {
    allSlots?: unknown[];
    slots?: unknown[];
    slotToServiceId?: Record<string, unknown>;
    defaultServiceId?: string | null;
  };

  const baseSlots = Array.isArray(payload.allSlots)
    ? payload.allSlots
    : Array.isArray(payload.slots)
    ? payload.slots
    : [];

  const slots = baseSlots.map((value) => asString(value)).filter((value) => value.length > 0);
  const slotToServiceId = payload.slotToServiceId ?? {};
  const serviceBySlot: Record<string, string> = {};
  Object.entries(slotToServiceId).forEach(([slot, serviceId]) => {
    const s = asString(slot);
    const sid = asString(serviceId);
    if (!s || !sid) return;
    serviceBySlot[s] = sid;
  });

  return {
    slots,
    serviceBySlot,
    defaultServiceId: payload.defaultServiceId ? asString(payload.defaultServiceId) : null,
  };
}

export function mapBookAppointmentForAgent(raw: unknown): {
  ok: boolean;
  appointmentId?: string;
  retcode?: number;
  message?: string;
  error?: unknown;
} {
  const payload = raw as {
    AppointmentID?: string | number;
    retcode?: number;
    Message?: string | null;
    error?: unknown;
  };

  const appointmentId = payload.AppointmentID !== undefined ? asString(payload.AppointmentID) : undefined;
  const retcode = payload.retcode;
  const ok = !!appointmentId && retcode === 0;

  return {
    ok,
    appointmentId,
    retcode,
    message: asString(payload.Message) || undefined,
    error: payload.error,
  };
}
