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

  const cityFilter = normalise(city ?? "");
  const branchFilter = normalise(branch ?? "");
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
