import { LamedDB, listen, type ListenOptions, type RunningServer } from "../src/index.js";

/** Key the shared test server and its clients send. */
export const TEST_API_KEY = "test-key";

export interface TestServer {
  server: RunningServer;
  db: LamedDB;
  /** `fetch` that already sends `Authorization: Bearer <test key>`. */
  fetch: typeof globalThis.fetch;
  apiKey: string;
}

/**
 * Start a server with a test key and return an SDK client and a fetch wrapper that send it.
 * Pass `apiKeys` to use a different list. The client and wrapper use the first key.
 */
export async function startTestServer(
  options: Partial<Omit<ListenOptions, "apiKeys">> & { apiKeys?: readonly string[] } = {},
): Promise<TestServer> {
  const apiKeys = options.apiKeys ?? [TEST_API_KEY];
  const listenOptions: ListenOptions = { apiKeys };

  if (options.port !== undefined) {
    listenOptions.port = options.port;
  }

  if (options.host !== undefined) {
    listenOptions.host = options.host;
  }

  if (options.store !== undefined) {
    listenOptions.store = options.store;
  }

  if (options.service !== undefined) {
    listenOptions.service = options.service;
  }

  const server = await listen(listenOptions);
  const apiKey = apiKeys[0] ?? TEST_API_KEY;

  return {
    server,
    apiKey,
    db: new LamedDB({ baseUrl: server.url, apiKey }),
    fetch: fetchWithApiKey(apiKey),
  };
}

export function fetchWithApiKey(apiKey: string, baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);

    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${apiKey}`);
    }

    return baseFetch(input, { ...init, headers });
  };
}
