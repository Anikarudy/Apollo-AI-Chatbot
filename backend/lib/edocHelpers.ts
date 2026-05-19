import { doctors, hospitalsByCity, getLocationFallbacksForCity } from "../../frontend/src/knowledgeBase";
import { getLocationFromBranch } from "../../data/locationMap";

export const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

/** Convert "1/7/2025" (D/M/YYYY) → "01-JUL-2025" */
export function toEdocDate(d: string): string {
  const [day, mon, yr] = d.split("/");
  return `${day.padStart(2, "0")}-${MONTHS[parseInt(mon) - 1]}-${yr}`;
}

/** Add `minutes` to "HH:MM" string → "HH:MM" */
export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function isNumericLocationId(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? "").trim());
}

/**
 * Detects EDOC's "no real schedule" fallback response.
 * EDOC returns a full 00:00–23:45 grid when a doctor has no actual schedule at that location.
 */
export function isFakeSchedule(slots: string[]): boolean {
  if (!slots || slots.length === 0) return false;
  if (slots.length >= 90) return true;
  if (slots[0] === "00:00") return true;
  return false;
}

/**
 * Resolve the correct RegionID for an EDOC call.
 * Uses the branch → regionId mapping when available; falls back to provided or 5.
 */
export function resolveRegionId(branch: string | undefined, provided?: string): number {
  if (provided && provided !== "5") return Number(provided);
  if (branch) {
    const mapped = getLocationFromBranch(branch);
    if (mapped) return Number(mapped.regionId);
  }
  return Number(provided ?? "5");
}

/**
 * Build an ordered list of locationId candidates to try for an EDOC call.
 * Tries: explicit provided → branch mapping → doctor record → city hospitals → fallbacks.
 */
export function getLocationCandidates(
  city?: string,
  preferred?: string,
  resourceId?: string,
  branch?: string,
): string[] {
  const result: string[] = [];
  const add = (v?: string) => {
    const val = String(v ?? "").trim();
    if (!val) return;
    if (!isNumericLocationId(val)) return;
    if (!result.includes(val)) result.push(val);
  };

  add(preferred);

  if (branch) {
    const mapped = getLocationFromBranch(branch);
    if (mapped) add(mapped.locationId);
  }

  const resourceInput = String(resourceId ?? "").trim();
  if (resourceInput) {
    doctors
      .filter((doctor) => String(doctor.resourceId ?? "").trim() === resourceInput)
      .forEach((doctor) => add(doctor.locationId));
  }

  const cityInput = String(city ?? "").trim();
  if (!cityInput) return result;

  const cityKey = Object.keys(hospitalsByCity).find(
    (k) => k.toLowerCase() === cityInput.toLowerCase(),
  );
  if (cityKey) {
    const hospitals = hospitalsByCity[cityKey] ?? [];
    hospitals.forEach((h) => add(h.locationId));
  }

  getLocationFallbacksForCity(cityInput).forEach((locationId) => add(locationId));
  return result;
}
