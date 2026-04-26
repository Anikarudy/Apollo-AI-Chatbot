/**
 * useChatMachine.ts
 * React hook that wraps the XState ApolloAssistRunner.
 * Exposes messages, currentState, and action functions to the UI.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ApolloAssistRunner, mapInputToEvent, AppEvent } from "../../apolloAssistMachine";
import { getStateResponse, ChatContext } from "../stateResponses";

export interface ChatMessage {
  id: number;
  sender: "bot" | "user";
  text: string;
}

let msgId = 0;
const nextId = () => ++msgId;

export function useChatMachine() {
  const runnerRef = useRef<ApolloAssistRunner | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentState, setCurrentState] = useState<string>("WELCOME");
  const [machineCtx, setMachineCtx] = useState<ChatContext>({});
  const [isLlmLoading, setIsLlmLoading] = useState(false);

  // Initialize runner once and push the opening welcome message
  useEffect(() => {
    const runner = new ApolloAssistRunner();
    runnerRef.current = runner;
    const initial = runner.currentState;
    setCurrentState(initial);

    // Show the bot's first message immediately without calling the LLM
    const welcome = getStateResponse(initial);
    setMessages([{ id: nextId(), sender: "bot", text: welcome.message }]);

    return () => runner.stop();
  }, []);

  // Static response — used for quick replies (no LLM call, no quota usage)
  const pushStaticBotMessage = useCallback((state: string, ctx: ChatContext) => {
    const resp = getStateResponse(state, ctx);
    setMessages((prev) => [
      ...prev,
      { id: nextId(), sender: "bot", text: resp.message },
    ]);
  }, []);

  // LLM response — only called when the user types a free-text message
  const pushLlmBotMessage = useCallback(async (state: string, ctx: Record<string, unknown>, userMessage: string) => {
    try {
      setIsLlmLoading(true);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentState: state, context: ctx, userMessage }),
      });
      if (res.ok) {
        const data = (await res.json()) as { text: string };
        setMessages((prev) => [
          ...prev,
          { id: nextId(), sender: "bot", text: data.text },
        ]);
        return;
      }
    } catch {
      // Server not running or quota exceeded – fall back to static
    } finally {
      setIsLlmLoading(false);
    }
    // Static fallback
    pushStaticBotMessage(state);
  }, [pushStaticBotMessage]);

  // Quick-reply / programmatic events: use static responses (no LLM quota)
  const sendEvent = useCallback(
    (eventType: string, value?: string) => {
      const runner = runnerRef.current;
      if (!runner) return;

      let event: AppEvent;
      if (value !== undefined) {
        event = { type: eventType, value } as AppEvent;
      } else {
        event = { type: eventType } as AppEvent;
      }
      runner.sendEvent(event);

      const nextState = runner.currentState;
      const nextCtx = runner.context as ChatContext;
      setCurrentState(nextState);
      setMachineCtx(nextCtx);
      pushStaticBotMessage(nextState, nextCtx);
    },
    [pushStaticBotMessage]
  );

  // Free-text input: call the LLM for a contextual response
  const sendUserText = useCallback(
    async (text: string) => {
      const runner = runnerRef.current;
      if (!runner) return;

      setMessages((prev) => [
        ...prev,
        { id: nextId(), sender: "user", text },
      ]);

      const event = mapInputToEvent(text, currentState);
      runner.sendEvent(event);

      const nextState = runner.currentState;
      const nextCtx = runner.context as ChatContext;
      setCurrentState(nextState);
      setMachineCtx(nextCtx);
      await pushLlmBotMessage(nextState, runner.context as Record<string, unknown>, text);
    },
    [currentState, pushLlmBotMessage]
  );

  const sendQuickReply = useCallback(
    (label: string, eventType: string, value?: string) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), sender: "user", text: label },
      ]);
      sendEvent(eventType, value);
    },
    [sendEvent]
  );

  return {
    messages,
    currentState,
    machineCtx,
    isLlmLoading,
    sendUserText,
    sendQuickReply,
  };
}
