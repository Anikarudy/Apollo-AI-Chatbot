import React, { useEffect, useRef, useState, KeyboardEvent } from "react";
import "./ChatWidget.css";
import { useChatMachine } from "../hooks/useChatMachine";
import type { LiveDate } from "../hooks/useChatMachine";
import { getStateResponse } from "../stateResponses";

/** Next 3 calendar days as a static fallback when live dates unavailable */
function staticFallbackDates(): LiveDate[] {
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const DAYS   = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
  return Array.from({ length: 3 }, (_, i) => {
    const dt = new Date();
    dt.setDate(dt.getDate() + i + 1);
    const d  = String(dt.getDate());
    const m  = MONTHS[dt.getMonth()];
    const y  = String(dt.getFullYear());
    return {
      display: `${d}/${dt.getMonth() + 1}/${y}`,
      edoc:    `${d.padStart(2, "0")}-${m}-${y}`,
      label:   DAYS[dt.getDay()],
      date:    d,
      month:   m,
    };
  });
}

const STATIC_SLOTS = ["10:30", "12:00", "14:00", "15:30", "17:00"];

const ChatWidget: React.FC = () => {
  const {
    messages, currentState, machineCtx, isLlmLoading, doctorCards,
    liveDates, liveSlots, slotsLoading,
    fetchSlotsForDate, selectDoctorForBooking,
    sendUserText, sendQuickReply, resetMachine,
  } = useChatMachine();

  const [inputText, setInputText] = useState("");
  const [selectedDateIdxByDoctor, setSelectedDateIdxByDoctor] = useState<Record<string, number>>({});
  const [selectedSlotByDoctor, setSelectedSlotByDoctor]       = useState<Record<string, string | null>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLlmLoading]);

  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS" && currentState !== "RESCHEDULE_APPOINTMENT") return;
    setSelectedDateIdxByDoctor({});
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
          <button
            aria-label="New conversation"
            title="New conversation"
            onClick={() => {
              setInputText("");
              setSelectedDateIdxByDoctor({});
              setSelectedSlotByDoctor({});
              resetMachine();
            }}
          >＋</button>
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

        {/* Doctor appointment cards — shown in SHOW_DOCTORS and RESCHEDULE_APPOINTMENT */}
        {(currentState === "SHOW_DOCTORS" || currentState === "RESCHEDULE_APPOINTMENT") && !isLlmLoading && (
          <div className="appt-card-wrap" aria-live="polite">
            {doctorCards.map((doctor, idx) => {
              const doctorKey = `${doctor.name}-${idx}`;
              const dates        = liveDates[doctorKey] ?? staticFallbackDates();
              const selectedIdx  = selectedDateIdxByDoctor[doctorKey] ?? 0;
              const selectedDate = dates[selectedIdx];
              const selectedSlot = selectedSlotByDoctor[doctorKey] ?? null;
              const slotKey      = `${doctorKey}||${selectedDate?.edoc ?? ""}`;
              const slots        = selectedDate
                ? (doctor.resourceId && doctor.locationId
                    ? (liveSlots[slotKey] ?? null)
                    : STATIC_SLOTS)
                : [];
              const isLoadingSlots = slotsLoading[slotKey] ?? false;

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
                    {doctor.resourceId && <p className="appt-resource-id">Resource ID: {doctor.resourceId}</p>}
                  </div>

                  {/* Date tabs */}
                  <div className="appt-day-tabs" role="tablist" aria-label={`Choose a day for ${doctor.name}`}>
                    {dates.map((day, dayIdx) => (
                      <button
                        key={`${doctorKey}-${day.edoc}`}
                        type="button"
                        role="tab"
                        aria-selected={selectedIdx === dayIdx}
                        className={`appt-day-btn ${selectedIdx === dayIdx ? "active" : ""}`}
                        onClick={() => {
                          setSelectedDateIdxByDoctor((prev) => ({ ...prev, [doctorKey]: dayIdx }));
                          setSelectedSlotByDoctor((prev) => ({ ...prev, [doctorKey]: null }));
                          if (doctor.resourceId && doctor.locationId) {
                            void fetchSlotsForDate(doctorKey, doctor.resourceId, doctor.locationId, doctor.regionId ?? "5", day.edoc);
                          }
                        }}
                      >
                        <span>{day.label}</span>
                        <strong>{day.date}</strong>
                        <small>{day.month}</small>
                      </button>
                    ))}
                  </div>

                  {/* Time slots */}
                  <div className="appt-slots" role="group" aria-label={`Available slots for ${doctor.name}`}>
                    {isLoadingSlots ? (
                      <p className="appt-no-slots">Loading slots…</p>
                    ) : slots === null ? (
                      <p className="appt-no-slots">Select a date to view slots.</p>
                    ) : slots.length > 0 ? (
                      slots.map((slot) => (
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
                    disabled={!selectedSlot || !selectedDate}
                    onClick={() => {
                      if (!selectedSlot || !selectedDate) return;
                      selectDoctorForBooking(doctor, selectedDate.edoc, selectedSlot);
                    }}
                  >
                    Book appointment
                  </button>

                  <div className="appt-secondary-actions">
                    <button type="button" className="appt-secondary-btn"
                      onClick={() => void sendQuickReply("Change search", "CHANGE_SEARCH")}>
                      Change search
                    </button>
                    <button type="button" className="appt-secondary-btn"
                      onClick={() => void sendQuickReply("Back to menu", "BACK_TO_MENU")}>
                      Back to menu
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Quick replies */}
        {stateResp.quickReplies.length > 0 && !isLlmLoading
          && currentState !== "SHOW_DOCTORS"
          && currentState !== "RESCHEDULE_APPOINTMENT" && (
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
