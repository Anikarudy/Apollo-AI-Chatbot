// scripts/extractWebData.js
// Run: node scripts/extractWebData.js
// Scrapes Apollo ProHealth sitemap + International Patients page and writes src/webData.generated.ts

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const TARGET_CITIES = ["Chennai", "Hyderabad", "Bangalore", "Mumbai"];
const PROHEALTH_SITEMAP_URL = "https://prohealth.apollohospitals.com/sitemap.xml";
const INTERNATIONAL_PAGE_URL = "https://www.apollohospitals.com/international-patient-services/";

const fallbackPackages = {
  Chennai: [
    {
      name: "Heart Health Checkup",
      description: "Comprehensive cardiac risk assessment",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/chennai/hospital/apollo-hospitals-greams-road-chennai/apollo-prohealth-heart-program",
    },
    {
      name: "Womens Health Checkup",
      description: "Complete womens wellness screen",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/chennai/hospital/apollo-hospitals-greams-road-chennai/apollo-prohealth-comprehensive-well-women-program",
    },
    {
      name: "Master Health Checkup",
      description: "All-round health assessment",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/chennai/hospital/apollo-hospitals-greams-road-chennai/apollo-prohealth-master-health-program",
    },
  ],
  Hyderabad: [
    {
      name: "Heart Health Checkup",
      description: "Cardiac risk panel",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/hyderabad/hospital/apollo-health-city-jubilee-hills/apollo-prohealth-heart-program",
    },
    {
      name: "Primary Health Checkup",
      description: "Basic annual wellness check",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/hyderabad/hospital/apollo-health-city-jubilee-hills/apollo-prohealth-primary-health-program",
    },
    {
      name: "Full Body Checkup",
      description: "Regal whole-body programme",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/hyderabad/hospital/apollo-health-city-jubilee-hills/apollo-prohealth-regal-whole-body-program",
    },
  ],
  Bangalore: [
    {
      name: "Heart Health Checkup",
      description: "Cardiac risk panel",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/bangalore/hospital/apollo-hospitals-bannerghatta-road/apollo-prohealth-heart-program",
    },
    {
      name: "Stroke Risk Checkup",
      description: "Neuro-vascular risk assessment",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/bangalore/hospital/apollo-hospitals-bannerghatta-road/apollo-prohealth-stroke-risk-program",
    },
    {
      name: "Full Body Checkup",
      description: "Regal whole-body programme",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/bangalore/hospital/apollo-hospitals-bannerghatta-road/apollo-prohealth-regal-whole-body-program",
    },
  ],
  Mumbai: [
    {
      name: "Heart Health Checkup",
      description: "Cardiac risk panel",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/mumbai/hospital/apollo-hospitals-navi-mumbai/apollo-prohealth-heart-program",
    },
    {
      name: "Womens Health Checkup",
      description: "Complete womens wellness screen",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/mumbai/hospital/apollo-hospitals-navi-mumbai/apollo-prohealth-comprehensive-well-women-program",
    },
    {
      name: "Master Health Checkup",
      description: "All-round health assessment",
      url: "https://prohealth.apollohospitals.com/book-health-check/ahc-packages/mumbai/hospital/apollo-hospitals-navi-mumbai/apollo-prohealth-master-health-program",
    },
  ],
};

const fallbackTopProcedures = [
  "CABG (Coronary Artery Bypass Grafting)",
  "PCI / Angioplasty with OCT/IVUS-guided stents",
  "TAVR / TAVI (Transcatheter Aortic Valve Replacement)",
  "Heart Transplant",
  "Proton Beam Therapy",
  "CAR-T Cell Therapy",
  "Bone Marrow Transplant (BMT)",
  "Stroke Care - Thrombolysis / Endovascular Stroke Therapy",
  "Robotic Knee Replacement",
  "Liver Transplant (Adult / Paediatric)",
  "Kidney Transplant",
  "Lung Transplant",
  "Assisted Reproductive Technologies (IVF / ICSI / ET)",
  "Robotic Bariatric Surgery",
  "LASIK Surgery",
];

function slugToTitle(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b(apollo|prohealth|program|package|health)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .replace(/\bWell Women\b/g, "Womens")
    .replace(/^$/, "Health Checkup");
}

function normalizeCity(rawCity) {
  const city = rawCity.trim().toLowerCase();
  if (city === "bangalore") return "Bangalore";
  if (city === "chennai") return "Chennai";
  if (city === "hyderabad") return "Hyderabad";
  if (city === "mumbai") return "Mumbai";
  return "";
}

async function scrapePackages() {
  const result = {
    Chennai: [],
    Hyderabad: [],
    Bangalore: [],
    Mumbai: [],
  };

  const response = await axios.get(PROHEALTH_SITEMAP_URL, {
    timeout: 20000,
    responseType: "text",
  });

  const xml = String(response.data || "");
  const locMatches = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  for (const url of locMatches) {
    const lower = url.toLowerCase();
    if (!lower.includes("/book-health-check/ahc-packages/")) continue;

    const cityMatch = lower.match(/\/ahc-packages\/([^/]+)\//);
    if (!cityMatch) continue;

    const city = normalizeCity(cityMatch[1]);
    if (!TARGET_CITIES.includes(city)) continue;

    const slug = url.replace(/\/$/, "").split("/").pop() || "";
    const name = `${slugToTitle(slug)} Checkup`;

    if (!result[city].some((pkg) => pkg.url === url)) {
      result[city].push({
        name,
        description: "Apollo ProHealth package",
        url,
      });
    }
  }

  for (const city of TARGET_CITIES) {
    result[city] = result[city].slice(0, 8);
  }

  const total = TARGET_CITIES.reduce((sum, city) => sum + result[city].length, 0);
  if (total < 8) {
    throw new Error("Not enough package URLs found in sitemap");
  }

  return result;
}

async function scrapeTopProcedures() {
  const response = await axios.get(INTERNATIONAL_PAGE_URL, {
    timeout: 20000,
    responseType: "text",
  });

  const $ = cheerio.load(String(response.data || ""));
  const candidates = [];

  $("li").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text || text.length < 12 || text.length > 140) return;

    const lower = text.toLowerCase();
    const looksMedical =
      lower.includes("surgery") ||
      lower.includes("transplant") ||
      lower.includes("therapy") ||
      lower.includes("replacement") ||
      lower.includes("oncology") ||
      lower.includes("angioplasty") ||
      lower.includes("ivf") ||
      lower.includes("dialysis") ||
      lower.includes("care");

    if (looksMedical) {
      candidates.push(text);
    }
  });

  const deduped = Array.from(new Set(candidates)).slice(0, 30);
  if (deduped.length < 10) {
    throw new Error("Could not extract enough procedure points from international page");
  }

  return deduped;
}

function writeGeneratedFile(healthPackages, topProcedures) {
  const out = `// AUTO-GENERATED by scripts/extractWebData.js - DO NOT EDIT MANUALLY
// Sources:
// - ${PROHEALTH_SITEMAP_URL}
// - ${INTERNATIONAL_PAGE_URL}

export interface HealthPackage {
  name: string;
  description: string;
  url: string;
}

export const healthPackages: Record<string, HealthPackage[]> = ${JSON.stringify(
    healthPackages,
    null,
    2
  )};

export const topProcedures: string[] = ${JSON.stringify(topProcedures, null, 2)};
`;

  const outPath = path.join(__dirname, "..", "src", "webData.generated.ts");
  fs.writeFileSync(outPath, out, "utf8");
  console.log(`Written ${outPath}`);
}

async function main() {
  let healthPackages = fallbackPackages;
  let topProcedures = fallbackTopProcedures;

  try {
    healthPackages = await scrapePackages();
    console.log("Scraped health package URLs from sitemap");
  } catch (err) {
    console.warn("Using fallback health packages:", err.message);
  }

  try {
    topProcedures = await scrapeTopProcedures();
    console.log("Scraped top procedures from international page");
  } catch (err) {
    console.warn("Using fallback top procedures:", err.message);
  }

  writeGeneratedFile(healthPackages, topProcedures);
}

main().catch((err) => {
  console.error("extractWebData failed:", err);
  process.exit(1);
});
