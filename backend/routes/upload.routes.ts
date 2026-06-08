import { Router, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import { generalLimiter } from "../middleware/rateLimit.middleware";
import { isValidSessionId } from "../middleware/session.middleware";

export const uploadRouter = Router();

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
]);
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const UPLOAD_DIR = path.join(process.cwd(), "backend", "tmp", "uploads");

interface PendingUpload {
  uploadId: string;
  token: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  size: number;
  filePath: string;
  createdAt: number;
  completed: boolean;
}

const pendingUploads = new Map<string, PendingUpload>();

async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function cleanupExpiredUploads(): void {
  const now = Date.now();
  for (const [uploadId, upload] of pendingUploads.entries()) {
    if (now - upload.createdAt > UPLOAD_TTL_MS) {
      pendingUploads.delete(uploadId);
      void fs.unlink(upload.filePath).catch(() => {
        // Ignore cleanup unlink errors.
      });
    }
  }
}

uploadRouter.post("/handshake", generalLimiter, async (req: Request, res: Response): Promise<void> => {
  if (req.sessionId === "anonymous" || !isValidSessionId(req.sessionId)) {
    res.status(401).json({ error: "X-Session-Id required" });
    return;
  }

  cleanupExpiredUploads();

  const files = ((req.body ?? {}) as { files?: Array<{ name: string; type: string; size: number }> }).files ?? [];
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "files required" });
    return;
  }

  try {
    await ensureUploadDir();
    const uploads = files.map((file) => {
      const name = String(file.name ?? "").trim();
      const type = String(file.type ?? "").trim().toLowerCase();
      const size = Number(file.size ?? 0);
      if (!name || !type || !Number.isFinite(size) || size <= 0) {
        throw new Error("Invalid file metadata");
      }
      if (!ALLOWED_MIME_TYPES.has(type)) {
        throw new Error(`Unsupported file type: ${type}`);
      }
      if (size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File too large: ${name}`);
      }

      const uploadId = crypto.randomUUID();
      const token = crypto.randomUUID();
      const safeName = sanitizeFileName(name);
      const filePath = path.join(UPLOAD_DIR, `${uploadId}-${safeName}`);

      pendingUploads.set(uploadId, {
        uploadId,
        token,
        sessionId: req.sessionId,
        fileName: name,
        mimeType: type,
        size,
        filePath,
        createdAt: Date.now(),
        completed: false,
      });

      return {
        uploadId,
        uploadUrl: `/api/uploads/presigned/${encodeURIComponent(uploadId)}?token=${encodeURIComponent(token)}`,
        fileUrl: `/api/uploads/files/${encodeURIComponent(uploadId)}`,
        expectedContentType: type,
      };
    });

    res.json({ uploads });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

uploadRouter.put(
  "/presigned/:uploadId",
  generalLimiter,
  expressRawBody(),
  async (req: Request, res: Response): Promise<void> => {
    const uploadId = String(req.params.uploadId ?? "").trim();
    const token = String(req.query.token ?? "").trim();

    const target = pendingUploads.get(uploadId);
    if (!target || !token || token !== target.token) {
      res.status(403).json({ error: "Invalid upload token" });
      return;
    }
    if (target.completed) {
      res.status(409).json({ error: "Upload already completed" });
      return;
    }

    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes(target.mimeType)) {
      res.status(400).json({ error: "MIME type mismatch" });
      return;
    }

    const body = req.body as Buffer;
    if (!body || !Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "No upload payload" });
      return;
    }
    if (body.length > target.size || body.length > MAX_FILE_SIZE_BYTES) {
      res.status(413).json({ error: "Upload payload exceeds declared size" });
      return;
    }

    await fs.writeFile(target.filePath, body);
    res.status(200).json({ ok: true });
  },
);

uploadRouter.post("/complete", generalLimiter, async (req: Request, res: Response): Promise<void> => {
  if (req.sessionId === "anonymous" || !isValidSessionId(req.sessionId)) {
    res.status(401).json({ error: "X-Session-Id required" });
    return;
  }

  const uploads = ((req.body ?? {}) as { uploads?: Array<{ uploadId: string }> }).uploads ?? [];
  if (!Array.isArray(uploads) || uploads.length === 0) {
    res.status(400).json({ error: "uploads required" });
    return;
  }

  const result = uploads.map((entry) => {
    const uploadId = String(entry.uploadId ?? "").trim();
    const target = pendingUploads.get(uploadId);
    if (!target || target.sessionId !== req.sessionId) {
      throw new Error(`Unknown uploadId: ${uploadId}`);
    }
    target.completed = true;
    pendingUploads.set(uploadId, target);
    return {
      uploadId,
      fileUrl: `/api/uploads/files/${encodeURIComponent(uploadId)}`,
      fileName: target.fileName,
    };
  });

  res.json({ uploaded: result });
});

uploadRouter.get("/files/:uploadId", generalLimiter, async (req: Request, res: Response): Promise<void> => {
  const uploadId = String(req.params.uploadId ?? "").trim();
  const target = pendingUploads.get(uploadId);
  if (!target || !target.completed) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  try {
    const file = await fs.readFile(target.filePath);
    res.setHeader("Content-Type", target.mimeType);
    res.setHeader("Content-Disposition", `inline; filename=\"${sanitizeFileName(target.fileName)}\"`);
    res.send(file);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

function expressRawBody() {
  return (req: Request, res: Response, next: () => void): void => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      chunks.push(chunk);
      totalSize += chunk.length;
      if (totalSize > MAX_FILE_SIZE_BYTES) {
        rejected = true;
        res.status(413).json({ error: "Upload too large" });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (rejected) return;
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on("error", () => {
      if (rejected) return;
      res.status(400).json({ error: "Failed to read upload body" });
    });
  };
}
