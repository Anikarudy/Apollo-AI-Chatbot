/**
 * Branch name → locationId + regionId mapping.
 * Each Apollo branch has exactly one locationId.
 * Keys are normalised to UPPER CASE — use getLocationFromBranch() to look up.
 */
export const BRANCH_LOCATION_MAP: Record<string, { locationId: string; regionId: string }> = {
  "JUBILEE HILLS":    { locationId: "10201", regionId: "1" },
  "HYDERAGUDA":       { locationId: "10202", regionId: "1" },
  "DRDO":             { locationId: "10204", regionId: "1" },
  "SECUNDERABAD":     { locationId: "10209", regionId: "1" },
  "FINANCIAL DISTRICT": { locationId: "10215", regionId: "1" },
};

function normalizeBranch(branch: string): string {
  return branch
    .toUpperCase()
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
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
