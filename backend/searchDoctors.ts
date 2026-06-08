/**
 * api/searchDoctors.ts
 *
 * Two fuzzy search functions powered by Fuse.js:
 *   1. searchDoctors()         — all-branch doctor search (used by Gemini tool calling)
 *   2. fuzzySearchAllDoctors() — full dataset (used by /api/doctors?name= to fix misspellings)
 *
 * The LLM NEVER touches doctor data directly — all results come from these functions.
 */

import Fuse from "fuse.js";
import { SchemaType, FunctionDeclaration, Schema } from "@google/generative-ai";
import { doctors, fuzzyDoctorsByName } from "../frontend/src/knowledgeBase";
export { fuzzyDoctorsByName as fuzzySearchAllDoctors } from "../frontend/src/knowledgeBase";

export interface ToolDoctor {
  name: string;
  specialty: string | null;
  city: string;
  branch: string | null;
  resourceId: string;
  locationId: string | null;
}

const allDoctors: ToolDoctor[] = doctors.map((doctor) => ({
  name: doctor.name,
  specialty: doctor.speciality ?? null,
  city: doctor.location,
  branch: doctor.branch || null,
  resourceId: doctor.resourceId,
  locationId: doctor.locationId || null,
}));

const US_TO_UK_SPECIALTY: Record<string, string> = {
  pediatrics: "paediatrics",
  gynecology: "gynaecology",
  gynecologist: "gynaecology",
  orthopedics: "orthopaedics",
  anesthesiology: "anaesthesiology",
  "fetal medicine": "foetal medicine",
  hematology: "haematology",
  "hemato oncology": "haemato oncology",
};

function normaliseSpecialtyValue(value: string): string {
  const lowered = normalise(value);
  return US_TO_UK_SPECIALTY[lowered] ?? lowered;
}

interface ValueHolder {
  value: string;
}

const cityOptions = Array.from(new Set(allDoctors.map((d) => d.city).filter(Boolean)));
const branchOptions = Array.from(new Set(allDoctors.map((d) => d.branch ?? "").filter(Boolean)));
const specialtyOptions = Array.from(
  new Set(allDoctors.map((d) => d.specialty ?? "").filter(Boolean)),
);

const cityFuse = new Fuse<ValueHolder>(cityOptions.map((value) => ({ value })), {
  keys: ["value"],
  threshold: 0.34,
  includeScore: true,
  ignoreLocation: true,
  minMatchCharLength: 2,
});

const branchFuse = new Fuse<ValueHolder>(branchOptions.map((value) => ({ value })), {
  keys: ["value"],
  threshold: 0.34,
  includeScore: true,
  ignoreLocation: true,
  minMatchCharLength: 2,
});

const specialtyFuse = new Fuse<ValueHolder>(
  specialtyOptions.map((value) => ({ value })),
  {
    keys: ["value"],
    threshold: 0.34,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 3,
  },
);

const cityExactMap = new Map(cityOptions.map((value) => [normalise(value), value] as const));
const branchExactMap = new Map(branchOptions.map((value) => [normalise(value), value] as const));
const specialtyExactMap = new Map(
  specialtyOptions.map((value) => [normaliseSpecialtyValue(value), value] as const),
);

function comparable(value: string): string {
  return normalise(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const row: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

function resolveCanonicalValue(
  input: string | undefined,
  exactMap: Map<string, string>,
  fuzzyIndex: Fuse<ValueHolder>,
  options: string[],
  normalizeInput: (value: string) => string = normalise,
): string | undefined {
  const raw = String(input ?? "").trim();
  if (!raw) return undefined;

  const normalized = normalizeInput(raw);
  const exact = exactMap.get(normalized);
  if (exact) return exact;

  const best = fuzzyIndex.search(raw, { limit: 1 })[0];
  if (best && (best.score ?? 1) <= 0.46) return best.item.value;

  // Fallback for heavier typos that Fuse score rejects.
  const inputComparable = comparable(normalized);
  if (!inputComparable) return undefined;

  let bestValue: string | undefined;
  let bestRatio = Number.POSITIVE_INFINITY;

  for (const option of options) {
    const optionComparable = comparable(normalizeInput(option));
    if (!optionComparable) continue;

    const distance = levenshtein(inputComparable, optionComparable);
    const ratio = distance / Math.max(inputComparable.length, optionComparable.length, 1);

    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestValue = option;
    }
  }

  if (bestValue && bestRatio <= 0.42) return bestValue;
  return undefined;
}

export function resolveDoctorFilters(filters: {
  city?: string;
  branch?: string;
  specialty?: string;
}): { city?: string; branch?: string; specialty?: string } {
  const city = resolveCanonicalValue(filters.city, cityExactMap, cityFuse, cityOptions, normalise);
  const branch = resolveCanonicalValue(filters.branch, branchExactMap, branchFuse, branchOptions, normalise);
  const specialty = resolveCanonicalValue(
    filters.specialty,
    specialtyExactMap,
    specialtyFuse,
    specialtyOptions,
    normaliseSpecialtyValue,
  );
  return { city, branch, specialty };
}

const fuse = new Fuse<ToolDoctor>(allDoctors, {
  keys: [
    { name: "name", weight: 0.55 },
    { name: "specialty", weight: 0.25 },
    { name: "city", weight: 0.1 },
    { name: "branch", weight: 0.1 },
  ],
  threshold: 0.35,
  includeScore: true,
  ignoreLocation: true,
  minMatchCharLength: 2,
});

function normalise(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function dedupeByIdentity(items: ToolDoctor[]): ToolDoctor[] {
  const seen = new Set<string>();
  const result: ToolDoctor[] = [];
  for (const doctor of items) {
    const key = `${normalise(doctor.name)}|${normalise(doctor.city)}|${normalise(doctor.branch ?? "")}|${normalise(doctor.resourceId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(doctor);
  }
  return result;
}

/**
 * Search doctors across all Apollo branches by name/specialty (fuzzy), with optional city/branch filters.
 * Returns top matches sorted by relevance.
 */
export function searchDoctors(query: string, city?: string, branch?: string, limit = 8): ToolDoctor[] {
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    console.log("[searchDoctors] Empty query — returning []");
    return [];
  }

  const resolvedFilters = resolveDoctorFilters({ city, branch });
  const cityFilter = normalise(resolvedFilters.city ?? city ?? "");
  const branchFilter = normalise(resolvedFilters.branch ?? branch ?? "");
  console.log(`[searchDoctors] Query: "${trimmed}" city="${cityFilter || "*"}" branch="${branchFilter || "*"}"`);

  let candidates = fuse
    .search(trimmed)
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
    .map((r) => r.item);

  if (cityFilter) {
    candidates = candidates.filter((doctor) => normalise(doctor.city) === cityFilter);
  }
  if (branchFilter) {
    candidates = candidates.filter((doctor) => normalise(doctor.branch ?? "") === branchFilter);
  }

  // Light fallback for severe misspellings: use existing full-data fuzzy name helper.
  if (candidates.length === 0) {
    let fallback = fuzzyDoctorsByName(trimmed, 50).map((doctor) => ({
      name: doctor.name,
      specialty: doctor.speciality ?? null,
      city: doctor.location,
      branch: doctor.branch || null,
      resourceId: doctor.resourceId,
      locationId: doctor.locationId || null,
    }));

    if (cityFilter) fallback = fallback.filter((doctor) => normalise(doctor.city) === cityFilter);
    if (branchFilter) fallback = fallback.filter((doctor) => normalise(doctor.branch ?? "") === branchFilter);
    candidates = fallback;
  }

  const top = dedupeByIdentity(candidates).slice(0, Math.max(1, limit));

  console.log(`[searchDoctors] Found ${top.length} result(s):`, top.map((d) => d.name));
  return top;
}

/** Gemini function-calling tool schema for searchDoctors */
export const SEARCH_DOCTORS_TOOL: FunctionDeclaration = {
  name: "searchDoctors",
  description:
    "Search for Apollo doctors across all branches and locations by name or specialty. " +
    "Handles misspellings and partial queries. ALWAYS call this tool when the user mentions any doctor name, specialty, or medical department.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      query: {
        type: SchemaType.STRING,
        description: "Doctor name or specialty to search for (may be misspelled or partial).",
      } as Schema,
      city: {
        type: SchemaType.STRING,
        description: "Optional city filter (e.g., Hyderabad, Chennai).",
      } as Schema,
      branch: {
        type: SchemaType.STRING,
        description: "Optional branch/hospital filter within the city.",
      } as Schema,
      limit: {
        type: SchemaType.NUMBER,
        description: "Optional max number of doctors to return (default 8, max 20).",
      } as Schema,
    },
    required: ["query"],
  },
};
