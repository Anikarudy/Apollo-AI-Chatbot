const fs = require("fs");

const input = JSON.parse(fs.readFileSync("./data/master-data.json", "utf-8"));

const BAD_KEYWORDS = [
  "TEAM",
  "UNIT",
  "CLINIC",
  "FUND",
  "PROGRAM",
  "GROUP",
  "APOLLO",
  "MICU",
  "ISURG",
  "PCCS",
  "ENDO",
  "COVID"
];

// --- CLEAN NAME ---
function cleanName(name) {
  return name
    .replace(/_/g, " ")
    .replace(/\(.*?\)/g, "") // remove (uro) etc
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- SPLIT MULTIPLE DOCTORS ---
function splitDoctors(name) {
  return name
    .replace(/Dr\.?/gi, "|Dr.")
    .replace(/\band\b/gi, "|")
    .replace(/\//g, "|")
    .split("|")
    .map(n => n.trim())
    .filter(n => n.length > 3);
}

// --- CHECK FAKE ---
function isFakeDoctor(name) {
  const upper = name.toUpperCase();

  if (BAD_KEYWORDS.some(k => upper.includes(k))) return true;

  // obvious junk short codes (Dr.YT, Dr.KS etc)
  if (/^DR\.[A-Z]{1,3}$/.test(upper)) return true;

  return false;
}

// --- NORMALIZE CASE ---
function formatName(name) {
  return name
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// --- LOCATION PARSE ---
function extractCityBranch(locationRaw) {
  if (!locationRaw) return { city: "", branch: "" };

  let location = locationRaw.toUpperCase().trim();

  // Navi Mumbai normalization
  if (
    location.includes("NAVI MUMBAI") ||
    location.includes("NAVI-MUMBAI") ||
    location.includes("NAVI MUMBAI CITY CENTER")
  ) {
    return {
      city: "MUMBAI",
      branch: "NAVI MUMBAI"
    };
  }

  if (location.includes("-")) {
    const [city, branch] = location.split("-").map(s => s.trim());

    if (city.includes("MUMBAI")) {
      return {
        city: "MUMBAI",
        branch: branch || "MAIN"
      };
    }

    return { city, branch };
  }

  if (location.includes("MUMBAI")) {
    return { city: "MUMBAI", branch: "MAIN" };
  }

  return { city: location, branch: "" };
}

// --- MAIN ---
const cleaned = [];
const seen = new Set();

input.doctors.forEach(doc => {
  const names = splitDoctors(doc.doctorName || "");

  names.forEach(name => {
    let cleanedName = cleanName(name);

    if (!cleanedName) return;
    if (isFakeDoctor(cleanedName)) return;

    cleanedName = formatName(cleanedName);

    // remove trailing "and"
    cleanedName = cleanedName.replace(/\bAnd$/i, "").trim();

    if (cleanedName.length < 5) return;

    const { city, branch } = extractCityBranch(doc.location);

    // 🔥 UPDATED DEDUP KEY (no locationId)
    const key = `${cleanedName}_${doc.resourceId}`;

    if (!seen.has(key)) {
      seen.add(key);

      cleaned.push({
        doctorName: cleanedName,
        resourceId: doc.resourceId,
        regionId: doc.regionId,
        city,
        branch,
        location: doc.location,
        speciality: (doc.speciality || "").replace(/UNIT.*/i, "").trim()
      });
    }
  });
});

// --- WRITE (OVERWRITES FILE) ---
fs.writeFileSync(
  "./data/clean.json",
  JSON.stringify({ doctors: cleaned }, null, 2)
);

console.log(`✅ Clean file generated with ${cleaned.length} doctors`);