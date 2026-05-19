import { Router, Request, Response } from "express";
import prisma from "../db/prismaClient";
import { getRedisConnection } from "../lib/redis";
import log from "../lib/logger";

export const healthRouter = Router();

// GET /health — simple liveness probe
healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    provider: process.env.DATA_PROVIDER ?? "postgres",
  });
});

// GET /ready — readiness probe: checks Postgres + Redis connectivity
healthRouter.get("/ready", async (_req: Request, res: Response) => {
  const checks: Record<string, "ok" | "error"> = {};
  let healthy = true;

  // Postgres
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = "ok";
  } catch (err) {
    log.warn({ err }, "[ready] Postgres check failed");
    checks.postgres = "error";
    healthy = false;
  }

  // Redis
  try {
    const redis = getRedisConnection();
    await redis.ping();
    checks.redis = "ok";
  } catch (err) {
    log.warn({ err }, "[ready] Redis check failed");
    checks.redis = "error";
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ready" : "degraded",
    ts: new Date().toISOString(),
    checks,
  });
});
