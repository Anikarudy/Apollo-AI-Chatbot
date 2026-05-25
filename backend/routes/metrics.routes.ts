import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/adminAuth.middleware";

export const metricsRouter = Router();

// GET /api/metrics — Prometheus metrics endpoint (stub: implement when prom-client is added)
metricsRouter.get("/metrics", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.status(501).json({ error: "Metrics not yet configured." });
});
