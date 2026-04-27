import React, { useEffect, useRef, useState, KeyboardEvent } from "react";
import "./ChatWidget.css";
import { useChatMachine } from "../hooks/useChatMachine";
import { getStateResponse } from "../stateResponses";

const ChatWidget: React.FC = () => {
  const { messages, currentState, machineCtx, isLlmLoading, doctorCards, sendUserText, sendQuickReply } =
    useChatMachine();
  const [inputText, setInputText] = useState("");
  const [selectedDayIndexByDoctor, setSelectedDayIndexByDoctor] = useState<Record<string, number>>({});
  const [selectedSlotByDoctor, setSelectedSlotByDoctor] = useState<Record<string, string | null>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const slotDays = [
    { label: "MON", date: "27", slots: ["10:30 AM", "12:00 PM", "05:30 PM"] },
    { label: "TUE", date: "28", slots: ["09:30 AM", "11:45 AM", "06:15 PM"] },
    { label: "WED", date: "06", slots: [] as string[] },
  ];

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLlmLoading]);

  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS") return;
    setSelectedDayIndexByDoctor({});
    setSelectedSlotByDoctor({});
  }, [currentState, doctorCards.length]);

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
            <div className={`chat-bubble ${msg.sender}`}>
              {/* Convert URLs in message to clickable links */}
              {msg.text.split(/(\bhttps?:\/\/[^\s]+)/g).map((part, i) =>
                /^https?:\/\//.test(part) ? (
                  <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="message-link">
                    {part}
                  </a>
                ) : (
                  <span key={i}>{part}</span>
                )
              )}
            </div>
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

        {/* Rich appointment booking card for doctor results */}
        {currentState === "SHOW_DOCTORS" && !isLlmLoading && (
          <div className="appt-card-wrap" aria-live="polite">
            {doctorCards.map((doctor, idx) => {
              const doctorKey = `${doctor.name}-${idx}`;
              const selectedDayIndex = selectedDayIndexByDoctor[doctorKey] ?? 0;
              const selectedSlot = selectedSlotByDoctor[doctorKey] ?? null;

              return (
                <article className="appt-card" key={doctorKey}>
                  <div className="appt-top">
                    <div className="appt-avatar" aria-hidden="true">👩‍⚕️</div>
                    <div className="appt-headline">
                      <h4>{doctor.name}</h4>
                      {doctor.profileUrl ? (
                        <a className="appt-view-profile" href={doctor.profileUrl} target="_blank" rel="noopener noreferrer">View profile</a>
                      ) : (
                        <span className="appt-view-profile muted">Profile unavailable</span>
                      )}
                      {doctor.specialty && <p>{doctor.specialty}</p>}
                    </div>
                  </div>

                  <div className="appt-meta">
                    <p>🏥 {doctor.hospital}</p>
                  </div>

                  <div className="appt-day-tabs" role="tablist" aria-label={`Choose a day for ${doctor.name}`}>
                    {slotDays.map((day, dayIdx) => (
                      <button
                        key={`${doctorKey}-${day.label}-${day.date}`}
                        type="button"
                        className={`appt-day-btn ${selectedDayIndex === dayIdx ? "active" : ""}`}
                        onClick={() => {
                          setSelectedDayIndexByDoctor((prev) => ({ ...prev, [doctorKey]: dayIdx }));
                          setSelectedSlotByDoctor((prev) => ({ ...prev, [doctorKey]: null }));
                        }}
                      >
                        <span>{day.label}</span>
                        <strong>{day.date}</strong>
                      </button>
                    ))}
                  </div>

                  <div className="appt-slots" role="group" aria-label={`Available slots for ${doctor.name}`}>
                    {slotDays[selectedDayIndex].slots.length > 0 ? (
                      slotDays[selectedDayIndex].slots.map((slot) => (
                        <button
                          key={`${doctorKey}-${slot}`}
                          type="button"
                          className={`appt-slot-btn ${selectedSlot === slot ? "selected" : ""}`}
                          onClick={() => setSelectedSlotByDoctor((prev) => ({ ...prev, [doctorKey]: slot }))}
                        >
                          {slot}
                        </button>
                      ))
                    ) : (
                      <p className="appt-no-slots">No slots available for this day.</p>
                    )}
                  </div>

                  <button
                    type="button"
                    className="appt-book-btn"
                    disabled={!selectedSlot}
                    onClick={() => {
                      if (!selectedSlot) return;
                      const day = slotDays[selectedDayIndex];
                      void sendQuickReply(
                        `Book ${doctor.name} (${day.label} ${day.date} • ${selectedSlot})`,
                        "SELECT_SLOT"
                      );
                    }}
                  >
                    Book appointment
                  </button>

                  <div className="appt-secondary-actions">
                    <button
                      type="button"
                      className="appt-secondary-btn"
                      onClick={() => void sendQuickReply("Change search", "CHANGE_SEARCH")}
                    >
                      Change search
                    </button>
                    <button
                      type="button"
                      className="appt-secondary-btn"
                      onClick={() => void sendQuickReply("Back to menu", "BACK_TO_MENU")}
                    >
                      Back to menu
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Quick replies – inline below the last bot message */}
        {stateResp.quickReplies.length > 0 && !isLlmLoading && currentState !== "SHOW_DOCTORS" && (
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
