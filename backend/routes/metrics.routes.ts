import { Router, Request, Response } from "express";

export const metricsRouter = Router();

// GET /api/metrics — Prometheus metrics endpoint (stub: implement when prom-client is added)
metricsRouter.get("/metrics", (_req: Request, res: Response) => {
  res.status(501).json({ error: "Metrics not yet configured." });
});
