/**
 * backend/services/chatSessionService.ts
 *
 * Manages ChatSession rows in apollo_audit.
 *
 * A session maps to one browser tab / one UUID stored in localStorage.
 * Sessions are upserted — if the browser reconnects with the same sessionId
 * we update the language rather than creating a duplicate row.
 */

import prisma from "../db/prismaClient";
import type { ChatSession } from "@prisma/client";

/**
 * Upsert a session.
 * Called at the start of every /api/chat request so the row always exists
 * before messages are inserted.
 */
export async function upsertSession(
  sessionId: string,
  language = "en"
): Promise<ChatSession> {
  return prisma.chatSession.upsert({
    where: { sessionId },
    create: { sessionId, language },
    update: { language, updatedAt: new Date() },
  });
}

/**
 * Retrieve a session and its most recent N messages (default 20).
 * Returns null if the session has never been seen before.
 */
export async function getSession(
  sessionId: string,
  messageLimit = 20
): Promise<(ChatSession & { messages: Awaited<ReturnType<typeof getRecentMessages>> }) | null> {
  const session = await prisma.chatSession.findUnique({
    where: { sessionId },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: messageLimit,
      },
    },
  });
  if (!session) return null;
  // Return messages in chronological order
  return { ...session, messages: session.messages.reverse() };
}

// Internal helper used only by getSession's return type inference
async function getRecentMessages(sessionId: string) {
  return prisma.chatMessage.findMany({ where: { sessionId } });
}
