/**
 * api/searchDoctors.ts
 *
 * Two fuzzy search functions powered by Fuse.js:
 *   1. searchDoctors()         — Jubilee Hills doctors only (used by Gemini tool calling)
 *   2. fuzzySearchAllDoctors() — full dataset (used by /api/doctors?name= to fix misspellings)
 *
 * The LLM NEVER touches doctor data directly — all results come from these functions.
 */

import Fuse from "fuse.js";
import { SchemaType, FunctionDeclaration, Schema } from "@google/generative-ai";
import jubileeDoctors from "../data/jubileeDoctors.json";
export { fuzzyDoctorsByName as fuzzySearchAllDoctors } from "../src/knowledgeBase";

export interface JubileeDoctor {
  name: string;
  specialty: string | null;
  location: string;
  resourceId: string;
  locationId: string | null;
}

const fuse = new Fuse<JubileeDoctor>(jubileeDoctors as JubileeDoctor[], {
  keys: [
    { name: "name", weight: 0.6 },
    { name: "specialty", weight: 0.4 },
  ],
  threshold: 0.4,
  includeScore: true,
  ignoreLocation: true,
  minMatchCharLength: 2,
});

/**
 * Search Jubilee Hills doctors by name or specialty (fuzzy).
 * Returns top 5 matches sorted by relevance.
 */
export function searchDoctors(query: string): JubileeDoctor[] {
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    console.log("[searchDoctors] Empty query — returning []");
    return [];
  }

  console.log(`[searchDoctors] Query: "${trimmed}"`);
  const results = fuse.search(trimmed);

  const top = results
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
    .slice(0, 5)
    .map((r) => r.item);

  console.log(`[searchDoctors] Found ${top.length} result(s):`, top.map((d) => d.name));
  return top;
}

/** Gemini function-calling tool schema for searchDoctors */
export const SEARCH_DOCTORS_TOOL: FunctionDeclaration = {
  name: "searchDoctors",
  description:
    "Search for doctors in Jubilee Hills Apollo Hospital by name or specialty. " +
    "Handles misspellings and partial queries. ALWAYS call this tool when the user mentions any doctor name, specialty, or medical department.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      query: {
        type: SchemaType.STRING,
        description: "Doctor name or specialty to search for (may be misspelled or partial).",
      } as Schema,
    },
    required: ["query"],
  },
};
