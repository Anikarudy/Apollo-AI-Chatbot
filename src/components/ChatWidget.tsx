import React, { useEffect, useRef, useState, KeyboardEvent } from "react";
import "./ChatWidget.css";
import { useChatMachine } from "../hooks/useChatMachine";
import { getStateResponse } from "../stateResponses";

const EDOC_MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function edocToDate(edoc: string): Date {
  const [d, m, y] = edoc.split("-");
  return new Date(parseInt(y), EDOC_MONTHS[m.toUpperCase()] ?? 0, parseInt(d));
}

const ChatWidget: React.FC = () => {
  const {
    messages, currentState, machineCtx, isLlmLoading, doctorCards, cardsAnchorMsgId,
    liveDates, liveSlots, slotsLoading,
    getServiceIdForSlot, fetchSlotsForDate, selectDoctorForBooking,
    requestAppointmentForDoctor,
    sendUserText, sendQuickReply, resetMachine,
  } = useChatMachine();

  const [inputText, setInputText] = useState("");
  const [selectedDateIdxByDoctor, setSelectedDateIdxByDoctor] = useState<Record<string, number>>({});
  const [selectedSlotByDoctor, setSelectedSlotByDoctor]       = useState<Record<string, string | null>>({});
  const [slotsOpenByDoctor, setSlotsOpenByDoctor]             = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLlmLoading]);

  useEffect(() => {
    if (currentState !== "SHOW_DOCTORS" && currentState !== "RESCHEDULE_APPOINTMENT") return;
    setSelectedDateIdxByDoctor({});
    setSelectedSlotByDoctor({});
    setSlotsOpenByDoctor({});
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
          <React.Fragment key={msg.id}>
            <div
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

            {/* Doctor cards anchored inline — only rendered once at their original position */}
            {msg.id === cardsAnchorMsgId && doctorCards.length > 0 && (
              <div className="appt-card-wrap" aria-live="polite">
                {doctorCards.map((doctor, idx) => {
                  const doctorKey = `${doctor.name}-${idx}`;
                  const hasLiveSchedule = !!doctor.resourceId && !!doctor.locationId;
                  const allDates     = liveDates[doctorKey] ?? [];
                  const hasDatesLoaded = Object.prototype.hasOwnProperty.call(liveDates, doctorKey);

                  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                  const dates = allDates.filter(day => edocToDate(day.edoc) >= todayStart);

                  const selectedIdx  = selectedDateIdxByDoctor[doctorKey] ?? 0;
                  const selectedDate = dates[selectedIdx];
                  const selectedSlot = selectedSlotByDoctor[doctorKey] ?? null;
                  const slotKey      = `${doctorKey}||${selectedDate?.edoc ?? ""}`;
                  const rawSlots     = selectedDate
                    ? (hasLiveSchedule ? (liveSlots[slotKey] ?? null) : [])
                    : [];

                  const isToday = selectedDate
                    ? edocToDate(selectedDate.edoc).getTime() === todayStart.getTime()
                    : false;
                  const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                  const slots = (rawSlots !== null && isToday)
                    ? rawSlots.filter(s => s > nowHHMM)
                    : rawSlots;

                  const isLoadingSlots = slotsLoading[slotKey] ?? false;
                  const slotsOpen     = slotsOpenByDoctor[doctorKey] ?? false;

                  return (
                    <article className="appt-card" key={doctorKey}>
                      <div className="appt-top">
                        <div className="appt-avatar" aria-hidden="true">👨‍⚕️</div>
                        <div className="appt-headline">
                          <h4>{doctor.name}</h4>
                          {doctor.profileUrl && (
                            <a className="appt-view-profile" href={doctor.profileUrl} target="_blank" rel="noopener noreferrer">View profile</a>
                          )}
                          {doctor.specialty && (<p>{doctor.specialty}</p>)}
                        </div>
                      </div>
                      <div className="appt-meta">
                        <p>🏥 {doctor.hospital}</p>
                      </div>
                      <button
                        type="button"
                        className="appt-slots-toggle"
                        onClick={() => {
                          const opening = !slotsOpen;
                          setSlotsOpenByDoctor((prev) => ({ ...prev, [doctorKey]: opening }));
                          if (opening && hasLiveSchedule && dates.length > 0 && selectedDate && doctor.resourceId && doctor.locationId) {
                            const slotKeyCheck = `${doctorKey}||${selectedDate.edoc}`;
                            if (!liveSlots[slotKeyCheck] && !(slotsLoading[slotKeyCheck])) {
                              void fetchSlotsForDate(doctorKey, doctor.resourceId, doctor.locationId, doctor.regionId ?? "5", selectedDate.edoc);
                            }
                          }
                        }}
                        aria-expanded={slotsOpen}
                      >
                        <span>Show available slots</span>
                        <span className="appt-slots-chevron">{slotsOpen ? "▲" : "▼"}</span>
                      </button>
                      {slotsOpen && (
                        <div className="appt-slots-panel">
                          {(() => {
                            const noLiveDates = hasDatesLoaded && dates.length === 0;
                            const noSchedule  = !hasLiveSchedule;
                            const showNoSlotsMsg = noSchedule || noLiveDates;
                            if (showNoSlotsMsg) {
                              return (
                                <div className="appt-no-slots-wrap">
                                  <p className="appt-no-slots">No slots available. Request an appointment and we&apos;ll get back to you.</p>
                                  <button type="button" className="appt-request-btn" onClick={() => requestAppointmentForDoctor(doctor)}>
                                    Request Appointment
                                  </button>
                                </div>
                              );
                            }
                            return (
                              <>
                                {dates.length > 0 ? (
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
                                ) : (
                                  <p className="appt-no-slots" style={{ padding: "10px 18px 0" }}>Loading available dates…</p>
                                )}
                                <div className="appt-slots" role="group" aria-label={`Available slots for ${doctor.name}`}>
                                  {isLoadingSlots ? (
                                    <p className="appt-no-slots">Loading slots…</p>
                                  ) : slots === null ? (
                                    <p className="appt-no-slots">Select a date above to view slots.</p>
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
                                  ) : selectedDate ? (
                                    <div className="appt-no-slots-wrap">
                                      <p className="appt-no-slots">No slots available for this day. Request an appointment and we&apos;ll get back to you.</p>
                                      <button type="button" className="appt-request-btn" onClick={() => requestAppointmentForDoctor(doctor)}>
                                        Request Appointment
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                                <button
                                  type="button"
                                  className="appt-book-btn"
                                  disabled={!selectedSlot || !selectedDate}
                                  onClick={() => {
                                    if (!selectedSlot || !selectedDate) return;
                                    const serviceId = getServiceIdForSlot(doctorKey, selectedDate.edoc, selectedSlot) ?? doctor.serviceId;
                                    selectDoctorForBooking(doctor, selectedDate.edoc, selectedSlot, serviceId);
                                  }}
                                >
                                  Book appointment
                                </button>
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </article>
                  );
                })}
                <div className="appt-global-actions">
                  <button type="button" className="appt-secondary-btn"
                    onClick={() => void sendQuickReply("Change search", "CHANGE_SEARCH")}>
                    Change search
                  </button>
                  <button type="button" className="appt-secondary-btn"
                    onClick={() => void sendQuickReply("Back to menu", "BACK_TO_MENU")}>
                    Back to menu
                  </button>
                </div>
              </div>
            )}
          </React.Fragment>
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

        {/* Quick replies */}
        {stateResp.quickReplies.length > 0 && !isLlmLoading
          && currentState !== "SHOW_DOCTORS"
          && currentState !== "RESCHEDULE_APPOINTMENT" && (
          <div key={`quick-${currentState}`} className="quick-replies" role="group" aria-label="Quick reply options">
            {stateResp.quickReplies.map((qr, idx) => (
              <button
                key={`${currentState}-${qr.eventType}-${qr.value ?? qr.label}-${idx}`}
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
