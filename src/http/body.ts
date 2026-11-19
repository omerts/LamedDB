import type { IncomingMessage } from "node:http";

import { LamedError } from "../errors.js";
import { LIMITS } from "../validate.js";

/** Body exceeded the limit. The response must be written before the socket is destroyed. */
export class OversizedBodyError extends LamedError {
  constructor() {
    super("invalid_argument", "Request body exceeds 1 MiB.");
    this.name = "OversizedBodyError";
  }
}

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

/** Read the body with the same 1 MiB cap as `readJsonBody`, without requiring JSON. */
export function readLimitedBody(req: IncomingMessage): Promise<Buffer> {
  return readLimited(req);
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
        // Stop reading so the remainder is never copied, but leave the socket
        // open until the caller has written the 400 response.
        req.pause();
        fail(new OversizedBodyError());

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
