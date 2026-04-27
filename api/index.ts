import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import * as cheerio from "cheerio";
import { buildDoctorSearchUrl, buildLlmContext, getDoctorsForLocation } from "../src/knowledgeBase";

dotenv.config();

const app = express();
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
app.use(cors({ origin: frontendOrigin }));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

interface ChatRequest {
  currentState: string;
  context: Record<string, string | undefined>;
  userMessage?: string;
}

interface ScrapedDoctor {
  name: string;
  profileUrl?: string;
}

function scrapeDoctorsFromHtml(html: string): ScrapedDoctor[] {
  const $ = cheerio.load(html);
  const results: ScrapedDoctor[] = [];
  const seen = new Set<string>();

  $("a[href*='/doctors/']").each((_, el) => {
    const raw = $(el).text().replace(/\s+/g, " ").trim();
    const href = $(el).attr("href");
    if (!raw) return;

    // Keep plausible doctor names only
    const looksLikeDoctor = /\bdr\.?\b/i.test(raw) || /^[A-Za-z .'-]{6,60}$/.test(raw);
    if (!looksLikeDoctor) return;

    const clean = raw.replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const profileUrl = href
      ? href.startsWith("http")
        ? href
        : `https://www.apollohospitals.com${href.startsWith("/") ? "" : "/"}${href}`
      : undefined;

    results.push({ name: clean, profileUrl });
  });

  return results.filter((d) => d.name.length >= 6 && d.name.length <= 80).slice(0, 12);
}

app.post("/api/chat", async (req: Request, res: Response): Promise<void> => {
  const { currentState, context, userMessage } = req.body as ChatRequest;

  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: "GEMINI_API_KEY not set" });
    return;
  }

  // Build a rich knowledge-base context block for the LLM
  const kbContext = buildLlmContext(currentState, context);

  const systemInstruction = `You are Apollo Assist, a friendly and professional AI health assistant for Apollo Hospitals India.

${kbContext}

Rules:
- Respond warmly and concisely (2-3 sentences max).
- Guide the user to their next logical action based on the current state.
- Use real hospital names, phone numbers, and package names from the knowledge base above.
- Do NOT invent doctor names, appointment slots, or medical diagnoses.
- For emergencies always lead with the emergency number: 1066.
- Always end with a clear call-to-action or question.`;

  const userContent = userMessage
    ? `User said: "${userMessage}"`
    : `Generate a warm, helpful response for state: ${currentState}`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction,
    });

    const result = await model.generateContent(userContent);
    const text = result.response.text();
    res.json({ text });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("Gemini error:", error);
    res.status(500).json({ error: error.message ?? "LLM call failed" });
  }
});

app.get("/api/doctors", async (req: Request, res: Response): Promise<void> => {
  const specialty = String(req.query.specialty ?? "").trim();
  const city = String(req.query.city ?? "").trim();
  const branch = String(req.query.branch ?? "").trim();

  // ── 1. Serve from local mapping first (no network needed) ──────────────
  if (city || branch) {
    const localDocs = getDoctorsForLocation(city, branch || undefined, specialty || undefined);
    if (localDocs.length > 0) {
      const url = buildDoctorSearchUrl(specialty, city, branch);
      res.json({
        url,
        source: "local",
        doctors: localDocs.slice(0, 12).map((d) => ({
          name: d.name,
          specialty: d.speciality,
          profileUrl: undefined,
        })),
      });
      return;
    }
  }

  // ── 2. Fallback: scrape Apollo website ─────────────────────────────────
  try {
    const url = buildDoctorSearchUrl(specialty, city, branch);
    const response = await axios.get<string>(url, {
      timeout: 12000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    const doctors = scrapeDoctorsFromHtml(response.data);
    res.json({ url, source: "scrape", doctors });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("Doctor scrape error:", error.message ?? err);
    res.status(500).json({
      error: "Failed to fetch doctor names",
      doctors: [],
    });
  }
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Apollo Assist backend running on http://localhost:${PORT}`);
});

