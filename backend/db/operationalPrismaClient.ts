/**
 * backend/db/operationalPrismaClient.ts
 *
 * Singleton Prisma client for the apollo_operational database.
 * Kept separate from the audit client so the two DBs are fully independent.
 */
import dotenv from "dotenv";
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require("@prisma/operational-client") as typeof import("@prisma/operational-client");

const operationalPrisma = new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
});

export default operationalPrisma;
