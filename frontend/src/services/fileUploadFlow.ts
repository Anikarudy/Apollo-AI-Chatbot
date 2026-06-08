import { createApiTransport } from "./transport";

export interface UploadHandshakeFile {
  name: string;
  type: string;
  size: number;
}

export interface UploadHandshakeResponse {
  uploads: Array<{
    uploadId: string;
    uploadUrl: string;
    fileUrl: string;
    expectedContentType: string;
  }>;
}

export interface UploadCompleteResponse {
  uploaded: Array<{
    uploadId: string;
    fileUrl: string;
    fileName: string;
  }>;
}

const transport = createApiTransport({
  agentId: "apollo-assist-web",
});

export async function uploadFileWithHandshake(params: {
  sessionId: string;
  file: File;
  caption?: string;
}): Promise<{ fileUrl: string; uploadId: string }> {
  const handshake = await transport.requestJson<UploadHandshakeResponse>({
    path: "/api/uploads/handshake",
    method: "POST",
    sessionId: params.sessionId,
    body: {
      files: [
        {
          name: params.file.name,
          type: params.file.type,
          size: params.file.size,
        } as UploadHandshakeFile,
      ],
    },
    retries: 1,
  });

  const target = handshake.uploads?.[0];
  if (!target) {
    throw new Error("Upload handshake did not return a target upload URL");
  }

  const uploadRes = await fetch(target.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": params.file.type || target.expectedContentType || "application/octet-stream",
    },
    body: params.file,
  });

  if (!uploadRes.ok) {
    throw new Error(`File upload failed with status ${uploadRes.status}`);
  }

  const complete = await transport.requestJson<UploadCompleteResponse>({
    path: "/api/uploads/complete",
    method: "POST",
    sessionId: params.sessionId,
    body: {
      uploads: [
        {
          uploadId: target.uploadId,
          caption: params.caption,
        },
      ],
    },
    retries: 1,
  });

  const uploaded = complete.uploaded?.[0];
  if (!uploaded?.fileUrl) {
    throw new Error("Upload complete did not return file URL");
  }

  return {
    fileUrl: uploaded.fileUrl,
    uploadId: uploaded.uploadId,
  };
}
