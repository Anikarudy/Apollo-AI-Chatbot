import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildLlmContext } from "../src/knowledgeBase";

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

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Apollo Assist backend running on http://localhost:${PORT}`);
});

