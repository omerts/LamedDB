import type { IncomingMessage } from "node:http";

import { LamedError } from "../errors.js";
import { LIMITS } from "../validate.js";

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  assertJsonContentType(req.headers["content-type"]);

  const buffer = await readLimited(req);

  if (buffer.length === 0) {
    throw new LamedError("invalid_argument", "Request body is required.");
  }

  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new LamedError("invalid_argument", "Request body must be valid JSON.");
  }
}

function assertJsonContentType(contentType: string | undefined): void {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();

  if (mediaType !== "application/json") {
    throw new LamedError("invalid_argument", "Content-Type must be application/json.");
  }
}

function readLimited(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    req.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }

      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buffer.length;

      if (total > LIMITS.maxBodyBytes) {
        fail(new LamedError("invalid_argument", "Request body exceeds 1 MiB."));
        req.destroy();

        return;
      }

      chunks.push(buffer);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      fail(error);
    });
  });
}
