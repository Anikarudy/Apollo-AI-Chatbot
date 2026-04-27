/**
 * useChatMachine.ts
 * React hook that wraps the XState ApolloAssistRunner.
 * Exposes messages, currentState, and action functions to the UI.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ApolloAssistRunner } from "../../apolloAssistMachine";
import { mapInputToEvent, AppEvent } from "../inputMapping.js";
import { getStateResponse, ChatContext } from "../stateResponses";

export interface ChatMessage {
  id: number;
  sender: "bot" | "user";
  text: string;
}

export interface DoctorCardData {
  name: string;
  specialty?: string;
  hospital: string;
  profileUrl?: string;
}

let msgId = 0;
const nextId = () => ++msgId;

export function useChatMachine() {
  const runnerRef = useRef<ApolloAssistRunner | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentState, setCurrentState] = useState<string>("WELCOME");
  const [machineCtx, setMachineCtx] = useState<ChatContext>({});
  const [isLlmLoading, setIsLlmLoading] = useState(false);
  const [doctorCards, setDoctorCards] = useState<DoctorCardData[]>([]);

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

  // Fetch scraped doctor names from Apollo website when showing doctor results
  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS") {
      setDoctorCards([]);
      return;
    }

    const hospital = machineCtx.branch
      ? `${machineCtx.branch}${machineCtx.city ? `, ${machineCtx.city}` : ""}`
      : machineCtx.city
      ? `Apollo Hospitals, ${machineCtx.city}`
      : "Selected Apollo location";

    const fallbackName = machineCtx.doctorName ?? (machineCtx.specialty ? `${machineCtx.specialty} specialist` : "Apollo doctor");

    const controller = new AbortController();

    const loadDoctors = async () => {
      try {
        const params = new URLSearchParams();
        if (machineCtx.specialty) params.set("specialty", machineCtx.specialty);
        if (machineCtx.city) params.set("city", machineCtx.city);
        if (machineCtx.branch) params.set("branch", machineCtx.branch);

        const res = await fetch(`/api/doctors?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!res.ok) throw new Error("doctor scrape failed");
        const data = (await res.json()) as {
          doctors?: Array<{ name: string; profileUrl?: string }>;
        };

        const cards = (data.doctors ?? []).slice(0, 6).map((d) => ({
          name: d.name,
          specialty: machineCtx.specialty,
          hospital,
          profileUrl: d.profileUrl,
        }));

        setDoctorCards(
          cards.length > 0
            ? cards
            : [{ name: fallbackName, specialty: machineCtx.specialty, hospital }]
        );
      } catch {
        setDoctorCards([{ name: fallbackName, specialty: machineCtx.specialty, hospital }]);
      }
    };

    void loadDoctors();

    return () => controller.abort();
  }, [currentState, machineCtx.branch, machineCtx.city, machineCtx.doctorName, machineCtx.specialty]);

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
    pushStaticBotMessage(state, ctx as ChatContext);
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
    doctorCards,
    sendUserText,
    sendQuickReply,
  };
}
