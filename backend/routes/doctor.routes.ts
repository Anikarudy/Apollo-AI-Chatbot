import { Router, Request, Response } from "express";
import { FunctionCallingMode } from "@google/generative-ai";
import {
  doctors,
  getDoctorsByName,
  getDoctorsForLocation,
  buildDoctorSearchUrl,
} from "../../frontend/src/knowledgeBase";
import {
  searchDoctors,
  SEARCH_DOCTORS_TOOL,
  fuzzySearchAllDoctors,
  resolveDoctorFilters,
} from "../searchDoctors";
import { genAI, hasAnyLlm, stripMarkdownJson, GEMINI_TOOL_MODEL } from "../lib/llmClient";
import {
  normaliseNameForIdLookup,
  dedupeDoctorsForCards,
  toDoctorCardPayload,
  buildDoctorQueryText,
  rerankDoctorCandidates,
} from "../lib/doctorUtils";

export const doctorRouter = Router();

// ── GET /api/doctors ──────────────────────────────────────────────────────────
doctorRouter.get("/doctors", async (req: Request, res: Response): Promise<void> => {
  const specialty = String(req.query.specialty ?? "").trim();
  const city      = String(req.query.city      ?? "").trim();
  const branch    = String(req.query.branch    ?? "").trim();
  const name      = String(req.query.name      ?? "").trim();

  const resolvedFilters = resolveDoctorFilters({ city, branch, specialty });
  const cityResolved = resolvedFilters.city ?? city;
  const branchResolved = resolvedFilters.branch ?? branch;
  const specialtyResolved = resolvedFilters.specialty ?? specialty;

  const normaliseDoctorName = (value: string): string =>
    value
      .toLowerCase()
      .replace(/\bdr\.?\s*/g, "")
      .replace(/[^a-z\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // Normalise specialty: handle US/UK spelling variants and case
  const US_TO_UK: Record<string, string> = {
    "pediatrics":       "paediatrics",
    "gynecology":       "gynaecology",
    "gynecologist":     "gynaecology",
    "orthopedics":      "orthopaedics",
    "anesthesiology":   "anaesthesiology",
    "fetal medicine":   "foetal medicine",
    "hematology":       "haematology",
    "hemato oncology":  "haemato oncology",
  };
  const normaliseSpecialty = (s: string) => {
    const lower = s.toLowerCase().trim();
    return US_TO_UK[lower] ?? lower;
  };
  const specNorm = normaliseSpecialty(specialtyResolved);

  // ── Name-based search: fuzzy via Fuse.js ──────────────────────────────────
  if (name) {
    const strictMatched = getDoctorsByName(name, 200);
    let matched = strictMatched.length > 0 ? strictMatched : fuzzySearchAllDoctors(name, 200);

    if (cityResolved) {
      matched = matched.filter((d: { location: string }) => d.location.toLowerCase() === cityResolved.toLowerCase());
    }
    if (branchResolved) {
      matched = matched.filter((d: { branch: string }) => d.branch.toLowerCase() === branchResolved.toLowerCase());
    }
    if (specialtyResolved) matched = matched.filter((d: { speciality: string }) => {
      const ds = normaliseSpecialty(d.speciality);
      return ds === specNorm || ds === specialtyResolved.toLowerCase();
    });

    const normalizedRequestedName = normaliseDoctorName(name);
    const hasExactNameMatch = matched.some(
      (doctor) => normaliseDoctorName(doctor.name) === normalizedRequestedName,
    );

    const uniqueMatched = dedupeDoctorsForCards(matched);
    const reranked = await rerankDoctorCandidates(
      buildDoctorQueryText({ name, specialty, city, branch }),
      uniqueMatched,
      12,
    );
    const url = buildDoctorSearchUrl(specialtyResolved, cityResolved, branchResolved);
    res.json({
      url,
      source: hasAnyLlm ? "local+llm-rerank" : "local",
      nameFallback:
        !hasExactNameMatch && uniqueMatched.length > 0
          ? { requestedName: name }
          : null,
      doctors: reranked.map(toDoctorCardPayload),
    });
    return;
  }

  // ── City/branch + optional specialty ─────────────────────────────────────
  if (cityResolved || branchResolved) {
    const localDocs = getDoctorsForLocation(
      cityResolved,
      branchResolved || undefined,
      specialtyResolved || undefined,
    );
    const finalDocs =
      localDocs.length > 0
        ? localDocs
        : specNorm !== specialtyResolved.toLowerCase()
        ? getDoctorsForLocation(cityResolved, branchResolved || undefined, specNorm)
        : [];
    if (finalDocs.length > 0) {
      const uniqueDocs = dedupeDoctorsForCards(finalDocs);
      const reranked = await rerankDoctorCandidates(
        buildDoctorQueryText({ specialty: specialtyResolved, city: cityResolved, branch: branchResolved }),
        uniqueDocs,
        12,
      );
      res.json({
        url: buildDoctorSearchUrl(specialtyResolved, cityResolved, branchResolved),
        source: hasAnyLlm ? "local+llm-rerank" : "local",
        doctors: reranked.map(toDoctorCardPayload),
      });
      return;
    }
  }

  // ── Specialty-only (no city/branch) ───────────────────────────────────────
  if (specialtyResolved && !cityResolved && !branchResolved) {
    const specDocs = dedupeDoctorsForCards(
      doctors
        .filter((d) => {
          const ds = normaliseSpecialty(d.speciality);
          return ds === specNorm || ds === specialtyResolved.toLowerCase();
        })
        .slice(0, 50),
    );
    if (specDocs.length > 0) {
      const reranked = await rerankDoctorCandidates(
        buildDoctorQueryText({ specialty: specialtyResolved }),
        specDocs,
        12,
      );
      res.json({
        url: buildDoctorSearchUrl(specialtyResolved),
        source: hasAnyLlm ? "local+llm-rerank" : "local",
        doctors: reranked.map(toDoctorCardPayload),
      });
      return;
    }
  }

  // ── Nothing found locally ─────────────────────────────────────────────────
  res.json({
    url: buildDoctorSearchUrl(specialtyResolved, cityResolved, branchResolved),
    source: "local",
    notFound: true,
    doctors: [],
  });
});

// ── POST /api/doctor-search ───────────────────────────────────────────────────
interface DoctorSearchRequest {
  message: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}

/**
 * Gemini tool-calling flow:
 * 1. Send user message + searchDoctors tool schema to Gemini
 * 2. If Gemini issues a tool call → execute searchDoctors(query) locally
 * 3. Return tool result to Gemini for a grounded natural-language response
 * 4. Respond with { text, doctors }
 *
 * LLM NEVER invents doctor data. All results come from local full-dataset retrieval.
 */
doctorRouter.post("/doctor-search", async (req: Request, res: Response): Promise<void> => {
  const { message, history } = (req.body ?? {}) as DoctorSearchRequest;

  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    const fallbackDoctors = searchDoctors(message);
    res.json({
      text:
        fallbackDoctors.length > 0
          ? `Found ${fallbackDoctors.length} doctor(s) matching your query.`
          : "No doctors found matching your query.",
      doctors: fallbackDoctors,
    });
    return;
  }

  const SYSTEM_PROMPT = `You are a hospital assistant for Apollo Hospitals India.

STRICT RULES:
- If the user mentions any doctor name, specialty, department, or medical term, you MUST call the "searchDoctors" tool.
- NEVER answer doctor queries from your training data or memory.
- NEVER hallucinate or invent doctor names or specialties.
- EVEN IF the input is misspelled or partial, STILL call the tool.
- Infer city/branch from user text when present and pass them to the tool as filters.
- After receiving tool results, respond naturally using ONLY those results.
- If no results are returned, say "No matching doctors found" and suggest broadening the search.`;

  try {
    const geminiModel = GEMINI_TOOL_MODEL;
    console.log(`[doctor-search] Gemini tool-calling with message: "${message}"`);

    const model = genAI.getGenerativeModel({
      model: geminiModel,
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: [SEARCH_DOCTORS_TOOL] }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
    });

    const chat = model.startChat({
      history: (history ?? []).slice(-6).map((h) => ({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: h.text }],
      })),
    });

    // Round 1: send user message; Gemini may issue a tool call
    const round1 = await chat.sendMessage(message);
    const round1Parts = round1.response.candidates?.[0]?.content?.parts ?? [];
    const fnCallPart = round1Parts.find((p) => p.functionCall);

    if (fnCallPart?.functionCall) {
      const fnName = fnCallPart.functionCall.name;
      const fnArgs = (fnCallPart.functionCall.args ?? {}) as Record<string, unknown>;

      console.log(`[doctor-search] Tool call: ${fnName}`, fnArgs);

      let toolResult: unknown = [];
      if (fnName === "searchDoctors") {
        const query = String(fnArgs.query ?? "").trim();
        const city = String(fnArgs.city ?? "").trim() || undefined;
        const branch = String(fnArgs.branch ?? "").trim() || undefined;
        const requestedLimit = Number(fnArgs.limit ?? 8);
        const limit = Number.isFinite(requestedLimit)
          ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
          : 8;
        toolResult = searchDoctors(query, city, branch, limit);
      }

      console.log(`[doctor-search] Tool result count:`, Array.isArray(toolResult) ? toolResult.length : "n/a");

      // Round 2: return tool result to Gemini for final grounded response
      const round2 = await chat.sendMessage([
        { functionResponse: { name: fnName, response: { result: toolResult } } },
      ]);

      const finalText = round2.response.text().trim();
      res.json({ text: finalText, doctors: toolResult });
      return;
    }

    // Gemini responded directly (no tool call needed)
    const directText = round1.response.text().trim();
    res.json({ text: directText, doctors: [] });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("[doctor-search] Error:", e.message ?? err);
    const fallbackDoctors = searchDoctors(message);
    res.json({
      text:
        fallbackDoctors.length > 0
          ? `Found ${fallbackDoctors.length} doctor(s) matching your query.`
          : "No doctors found matching your query.",
      doctors: fallbackDoctors,
    });
  }
});
