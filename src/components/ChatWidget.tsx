import React, { useEffect, useRef, useState, KeyboardEvent } from "react";
import "./ChatWidget.css";
import { useChatMachine } from "../hooks/useChatMachine";
import { getStateResponse } from "../stateResponses";

const ChatWidget: React.FC = () => {
  const { messages, currentState, machineCtx, isLlmLoading, sendUserText, sendQuickReply } =
    useChatMachine();
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLlmLoading]);

  const stateResp = getStateResponse(currentState, machineCtx);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text) return;
    setInputText("");
    await sendUserText(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void handleSend();
  };

  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="chat-widget" role="dialog" aria-label="Apollo Assist chat">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-avatar">🏥</div>
        <div className="chat-header-info">
          <h3>Apollo Assist</h3>
          <p>
            <span className="online-dot" />
            Here for You 24/7
          </p>
        </div>
        <div className="chat-header-actions">
          <button aria-label="New conversation" title="New conversation">＋</button>
          <button aria-label="Expand" title="Expand">⤢</button>
          <button aria-label="Close" title="Close">✕</button>
        </div>
      </div>

      {/* Messages */}
      <div className="chat-messages" role="log" aria-live="polite">
        <div className="chat-date-label">{dateLabel}</div>

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-msg-row ${msg.sender}`}
          >
            {msg.sender === "bot" && (
              <div className="chat-msg-avatar" aria-hidden="true">
                👩‍⚕️
              </div>
            )}
            <div className={`chat-bubble ${msg.sender}`}>{msg.text}</div>
          </div>
        ))}

        {/* Typing indicator while LLM is thinking */}
        {isLlmLoading && (
          <div className="chat-msg-row">
            <div className="chat-msg-avatar" aria-hidden="true">👩‍⚕️</div>
            <div className="chat-bubble bot typing" aria-label="Apollo is typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}

        {/* Quick replies – inline below the last bot message */}
        {stateResp.quickReplies.length > 0 && !isLlmLoading && (
          <div className="quick-replies" role="group" aria-label="Quick reply options">
            {stateResp.quickReplies.map((qr) => (
              <button
                key={qr.label}
                className="quick-reply-btn"
                onClick={() => void sendQuickReply(qr.label, qr.eventType, qr.value)}
              >
                {qr.label}
              </button>
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="chat-input-bar">
        <button className="chat-input-attach" aria-label="Attach file">＋</button>
        <input
          className="chat-input-field"
          type="text"
          placeholder={stateResp.inputPlaceholder ?? "Message Apollo Assist…"}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Type a message"
          disabled={!stateResp.showInput && stateResp.quickReplies.length > 0}
        />
        <button className="chat-input-mic" aria-label="Voice input">🎤</button>
      </div>

      {/* Footer */}
      <div className="chat-footer">
        Powered by <span>Apollo Health Axis</span>
      </div>
    </div>
  );
};

export default ChatWidget;
