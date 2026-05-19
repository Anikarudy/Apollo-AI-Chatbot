import { doctors } from "../../frontend/src/knowledgeBase";
import { callLlm, hasAnyLlm, stripMarkdownJson } from "./llmClient";

export type LocalDoctor = (typeof doctors)[number];

export interface DoctorCardPayload {
  resourceIds: string[];
  name: string;
  specialty: string;
  hospital: string;
  profileUrl: undefined;
  resourceId: string;
  locationId: string;
  regionId: string;
  serviceId: string;
}

export function normaliseNameForIdLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bdr\.?\s*/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getResourceCandidatesForDoctor(doctorName: string, city: string): string[] {
  const nameKey = normaliseNameForIdLookup(doctorName);
  const cityKey = city.toLowerCase();
  const candidates = doctors
    .filter((d) => d.location.toLowerCase() === cityKey)
    .filter((d) => normaliseNameForIdLookup(d.name) === nameKey)
    .map((d) => String(d.resourceId ?? "").trim())
    .filter((v) => v.length > 0);
  return Array.from(new Set(candidates)).slice(0, 8);
}

export function dedupeDoctorsForCards(items: LocalDoctor[]): LocalDoctor[] {
  const seen = new Set<string>();
  const result: LocalDoctor[] = [];
  for (const doctor of items) {
    const nameKey = normaliseNameForIdLookup(doctor.name);
    const locationId = String(doctor.locationId ?? "").trim();
    const regionId = String(doctor.regionId ?? "5").trim();
    const city = String(doctor.location ?? "").trim().toLowerCase();
    const branch = String(doctor.branch ?? "").trim().toLowerCase();
    const locationKey = locationId || `${city}|${branch}`;
    const key = `${nameKey}|${locationKey}|${regionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(doctor);
  }
  return result;
}

export function toDoctorCardPayload(doctor: LocalDoctor): DoctorCardPayload {
  return {
    resourceIds: getResourceCandidatesForDoctor(doctor.name, doctor.location),
    name: doctor.name,
    specialty: doctor.speciality,
    hospital: doctor.branch
      ? `Apollo ${doctor.branch}, ${doctor.location}`
      : `Apollo Hospitals, ${doctor.location}`,
    profileUrl: undefined,
    resourceId: doctor.resourceId,
    locationId: doctor.locationId,
    regionId: doctor.regionId || "5",
    serviceId: doctor.serviceId,
  };
}

export function buildDoctorQueryText(params: {
  name?: string;
  specialty?: string;
  city?: string;
  branch?: string;
}): string {
  const parts = [
    String(params.name ?? "").trim(),
    String(params.specialty ?? "").trim(),
    String(params.branch ?? "").trim(),
    String(params.city ?? "").trim(),
  ].filter((v) => v.length > 0);
  return parts.join(" | ");
}

export async function rerankDoctorCandidates(
  queryText: string,
  candidates: LocalDoctor[],
  limit = 12,
): Promise<LocalDoctor[]> {
  if (!hasAnyLlm || candidates.length <= 1) return candidates.slice(0, limit);

  const shortlist = candidates.slice(0, 10);
  const compactCandidates = shortlist.map((doctor, index) => ({
    rank: index + 1,
    name: doctor.name,
    specialty: doctor.speciality,
    city: doctor.location,
    branch: doctor.branch,
  }));

  const systemPrompt = `You are a doctor-search ranking assistant.
You receive a user search query and up to 10 retrieved doctor candidates.
Return ONLY a JSON object with this exact schema:
{
  "selectedRanks": number[]
}

Rules:
- Select the most relevant candidates for the query intent.
- Prioritise semantic intent, not just literal token overlap.
- Respect location/specialty cues when present.
- Keep order best-first.
- Return only rank numbers from the provided list.
- Return at least 1 rank and at most ${Math.min(limit, 10)} ranks.
- Return raw JSON only, no markdown.`;

  const userPrompt = JSON.stringify({ query: queryText, candidates: compactCandidates });

  try {
    const raw = stripMarkdownJson(await callLlm(systemPrompt, userPrompt));
    const parsed = JSON.parse(raw) as { selectedRanks?: unknown };
    const ranks = Array.isArray(parsed.selectedRanks) ? parsed.selectedRanks : [];
    const selected = Array.from(
      new Set(
        ranks
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 1 && value <= shortlist.length),
      ),
    )
      .slice(0, Math.min(limit, shortlist.length))
      .map((rank) => shortlist[rank - 1]);

    if (selected.length > 0) return selected;
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.warn(
      "[LLM] Doctor rerank failed, falling back to retrieval order:",
      String(error.message ?? err),
    );
  }

  return shortlist.slice(0, limit);
}
