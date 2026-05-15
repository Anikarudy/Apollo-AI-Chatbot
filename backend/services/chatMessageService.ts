/**
 * backend/services/chatMessageService.ts
 *
 * Writes individual chat messages to apollo_audit.
 *
 * Design rules:
 * - All writes are fire-and-forget at the call site (caller does `void logMessage(...)`)
 * - This module never throws to the caller — errors are logged internally
 * - upsertSession() must be called before logMessage() for a given sessionId
 *   (the FK on ChatMessage.sessionId requires the parent row to exist)
 */

import prisma from "../db/prismaClient";
import type { ChatMessage, Prisma } from "@prisma/client";

export interface LogMessageInput {
  sessionId: string;
  role: "user" | "bot";
  message: string;
  messageType?: string;  // "text" | "quick_reply" | "doctor_selection" | "slot_selection" | "system_event"
  buttonLabel?: string;  // display label of the button clicked
  buttonValue?: string;  // machine value / event type of the button
  machineState?: string;
  agentAction?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one message row.
 * Silently swallows DB errors so a persistence failure never crashes a request.
 */
export async function logMessage(input: LogMessageInput): Promise<ChatMessage | null> {
  try {
    return await prisma.chatMessage.create({
      data: {
        sessionId:    input.sessionId,
        role:         input.role,
        message:      input.message,
        messageType:  input.messageType  ?? null,
        buttonLabel:  input.buttonLabel  ?? null,
        buttonValue:  input.buttonValue  ?? null,
        machineState: input.machineState ?? null,
        agentAction:  input.agentAction  ?? null,
        metadata:     input.metadata ? (input.metadata as Prisma.InputJsonValue) : undefined,
      },
    });
  } catch (err) {
    // Log but never propagate — chat must work even if audit DB is down
    console.error("[chatMessageService] logMessage failed:", err);
    return null;
  }
}

/**
 * Fetch all messages for a session in chronological order.
 * Useful for debugging or replaying a conversation.
 */
export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  return prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
}
