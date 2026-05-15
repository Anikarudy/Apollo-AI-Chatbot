/*
  Usage:
    node scripts/smokeAgentQuery.js
    node scripts/smokeAgentQuery.js http://127.0.0.1:3113
*/

(async () => {
  const base = String(process.argv[2] || "http://127.0.0.1:3001").replace(/\/$/, "");

  const req = async (path, options = {}) => {
    const response = await fetch(base + path, options);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Keep null when endpoint does not return JSON.
    }
    return { status: response.status, json, text };
  };

  const doctorsResp = await req("/api/doctors?city=Hyderabad&specialty=Cardiology");
  const doctors = Array.isArray(doctorsResp.json?.doctors) ? doctorsResp.json.doctors : [];
  const doctor = doctors[0];

  let agent = {
    status: null,
    action: null,
    liveDates: 0,
    liveSlots: 0,
    note: null,
    error: null,
  };

  if (typeof doctor !== "undefined") {
    const resourceId = String(doctor.resourceId || doctor.resourceIds?.[0] || "");
    const locationId = String(doctor.locationId || "");
    const regionId = String(doctor.regionId || "5");

    const agentResp = await req("/api/agent/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Show availability and live slots for this doctor",
        context: { city: "Hyderabad", resourceId, locationId, regionId },
      }),
    });

    agent = {
      status: agentResp.status,
      action: agentResp.json?.action ?? null,
      liveDates: agentResp.json?.liveDates?.dates?.length || 0,
      liveSlots: agentResp.json?.liveSlots?.slots?.length || 0,
      note: agentResp.json?.note ?? null,
      error:
        typeof agentResp.json?.error === "string"
          ? agentResp.json.error
          : (agentResp.text || "").slice(0, 200),
    };
  }

  const guardResp = await req("/api/edoc/book-appointment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ResourceID: "700102",
      StartDateTime: "01-JAN-2026 10:00:00",
      EndDateTime: "01-JAN-2026 10:15:00",
      LocationID: "locationid",
      UHIDNumber: "U12345",
    }),
  });

  console.log(
    JSON.stringify(
      {
        base,
        doctorsStatus: doctorsResp.status,
        doctorsCount: doctors.length,
        firstDoctor: typeof doctor !== "undefined" ? String(doctor.name || "") : null,
        agent,
        guardStatus: guardResp.status,
        guardBody: (guardResp.text || "").slice(0, 200),
      },
      null,
      2
    )
  );
})().catch((error) => {
  console.error("SMOKE_ERROR", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
