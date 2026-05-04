/**
 * Branch name → locationId + regionId mapping.
 * Each Apollo branch has exactly one locationId.
 * Keys are normalised to UPPER CASE — use getLocationFromBranch() to look up.
 *
 * Key convention: use the branch segment from the "City - Branch" location string,
 * uppercased. For single-hospital cities the key is the city name itself.
 */
export const BRANCH_LOCATION_MAP: Record<string, { locationId: string; regionId: string }> = {
  // ── Hyderabad (Region 1) ─────────────────────────────────────────────────
  "JUBILEE HILLS":      { locationId: "10201", regionId: "1" },
  "HYDERAGUDA":         { locationId: "10202", regionId: "1" },
  "VIKRAMAPURI":        { locationId: "10202", regionId: "1" }, // served by Hyderaguda
  "DRDO":               { locationId: "10204", regionId: "1" },
  "SECUNDERABAD":       { locationId: "10209", regionId: "1" },
  "FINANCIAL DISTRICT": { locationId: "10215", regionId: "1" },

  // ── Delhi / NCR (Region 4) ───────────────────────────────────────────────
  "SARITA VIHAR":       { locationId: "10701", regionId: "4" },
  "NEW DELHI":          { locationId: "10701", regionId: "4" }, // Apollo Womens Cancer Centre branch string
  "NOIDA":              { locationId: "10702", regionId: "4" },

  // ── Kolkata (Region 3) ───────────────────────────────────────────────────
  "KOLKATA":            { locationId: "10801", regionId: "3" },
  "GLENEAGLES":         { locationId: "10801", regionId: "3" },

  // ── Chennai (Region 2) ───────────────────────────────────────────────────
  "GREAMS ROAD":        { locationId: "10101", regionId: "2" },
  "MAIN GREAMS ROAD":   { locationId: "10101", regionId: "2" }, // "Main, Greams Road" after comma-strip
  "TEYNAMPET":          { locationId: "10102", regionId: "2" },
  "TONDIARPET":         { locationId: "10104", regionId: "2" },
  "ARAGONDA":           { locationId: "10106", regionId: "2" },
  "CHILDREN HOSPITAL":  { locationId: "10107", regionId: "2" },
  "CHILDREN HOSPITALS": { locationId: "10107", regionId: "2" },
  "VANAGARAM":          { locationId: "10108", regionId: "2" },
  "OMR":                { locationId: "10110", regionId: "2" },

  // ── Lucknow (Region 2) ───────────────────────────────────────────────────
  "LUCKNOW":            { locationId: "13001", regionId: "2" },

  // ── Visakhapatnam (Region 1) ─────────────────────────────────────────────
  "VISAKHAPATNAM":              { locationId: "10361", regionId: "1" },
  "HEALTH CITY":                { locationId: "10362", regionId: "1" },
  "HEALTH CITY VISAKHAPATNAM":  { locationId: "10362", regionId: "1" }, // full branch string in dataset

  // ── Kakinada (Region 1) ──────────────────────────────────────────────────
  "KAKINADA":           { locationId: "10901", regionId: "1" },

  // ── Karim Nagar / Karimnagar (Region 1) ──────────────────────────────────
  "KARIM NAGAR":        { locationId: "12101", regionId: "1" },
  "KARIMNAGAR":         { locationId: "12101", regionId: "1" },

  // ── Nashik (Region 1) ────────────────────────────────────────────────────
  "NASHIK":             { locationId: "12102", regionId: "1" },

  // ── Indore (Region 1) ────────────────────────────────────────────────────
  "INDORE":             { locationId: "10381", regionId: "1" },

  // ── Bangalore (Region 8) ─────────────────────────────────────────────────
  "JAYANAGAR":               { locationId: "10371", regionId: "8" },
  "ELECTRONIC CITY":         { locationId: "10373", regionId: "8" },
  "HSR":                     { locationId: "10374", regionId: "8" },
  "SHESHADRIPURAM":          { locationId: "10391", regionId: "8" },
  "BANNERGHATTA":            { locationId: "10601", regionId: "8" },
  "MAIN BANNERGHATTA ROAD":  { locationId: "10601", regionId: "8" }, // full branch string in dataset

  // ── Mysore (Region 8) ────────────────────────────────────────────────────
  "MYSORE":             { locationId: "10351", regionId: "8" },

  // ── Bhubaneswar (Region 6) ───────────────────────────────────────────────
  "BHUBANESWAR":        { locationId: "10401", regionId: "6" },

  // ── Bhopal (Region 10) ───────────────────────────────────────────────────
  "BHOPAL":             { locationId: "17101", regionId: "10" },

  // ── Pune (Region 5) ──────────────────────────────────────────────────────
  "PUNE":               { locationId: "12301", regionId: "5" },

  // ── Mumbai (Region 5) ────────────────────────────────────────────────────
  "MUMBAI":             { locationId: "10551", regionId: "5" },

  // ── Ahmedabad (Region 5) ─────────────────────────────────────────────────
  "AHMEDABAD":          { locationId: "11001", regionId: "5" },

  // ── Chennai extra branches (Region 2) ────────────────────────────────────
  "KARAPAKKAM":         { locationId: "10110", regionId: "2" }, // same as OMR
  "WOMEN AND CHILDREN": { locationId: "10111", regionId: "2" },
  "WOMEN CHILDREN":     { locationId: "10111", regionId: "2" },
  "PROTON":             { locationId: "10113", regionId: "2" },
  "PROTON CANCER CENTRE": { locationId: "10113", regionId: "2" },
  "KOTTURPURAM":        { locationId: "15104", regionId: "2" }, // Apollo Heart Centre

  // ── Madurai (Region 2) ───────────────────────────────────────────────────
  "MADURAI":            { locationId: "10301", regionId: "2" },
  "LAKEVIEW":           { locationId: "10301", regionId: "2" },
  "LAKEVIEW ROAD":      { locationId: "10301", regionId: "2" },
  "FIRST MED":          { locationId: "10301", regionId: "2" }, // Madurai First Med alias

  // ── Tamil Nadu single-hospital cities (Region 2) ──────────────────────────
  "KARUR":              { locationId: "10311", regionId: "2" },
  "KARAIKUDI":          { locationId: "10321", regionId: "2" },
  "TRICHY":             { locationId: "10331", regionId: "2" },

  // ── Andhra Pradesh (Region 2) ────────────────────────────────────────────
  "NELLORE":            { locationId: "10341", regionId: "2" },

  // ── Odisha (Region 2 / 6) ────────────────────────────────────────────────
  "ROURKELA":           { locationId: "10408", regionId: "2" },
  // Bhubaneswar already mapped above (Region 6)

  // ── Chhattisgarh (Region 2) ──────────────────────────────────────────────
  "BILASPUR":           { locationId: "10501", regionId: "2" },

  // ── Kerala (Region 2) ────────────────────────────────────────────────────
  "KOCHI":              { locationId: "14101", regionId: "2" },
  "ADLUX":              { locationId: "14101", regionId: "2" },

  // ── Guwahati (Region 1) ──────────────────────────────────────────────────
  "GUWAHATI":           { locationId: "17001", regionId: "1" },
  "EXCELCARE":          { locationId: "17051", regionId: "1" },

  // ── Warangal (Region 1) ──────────────────────────────────────────────────
  "WARANGAL":           { locationId: "17201", regionId: "1" },
};

function normalizeBranch(branch: string): string {
  return branch
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9 ]/g, " ") // strip punctuation (commas, parens, hyphens…)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Given a branch name (any casing), returns { locationId, regionId } or null.
 */
export function getLocationFromBranch(
  branch: string
): { locationId: string; regionId: string } | null {
  const key = normalizeBranch(branch);
  return BRANCH_LOCATION_MAP[key] ?? null;
}
