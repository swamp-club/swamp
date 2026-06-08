// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

/** A recorded fetch call for inspection. */
export interface CapturedFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
}

/** Result from withMockedFetch — includes the callback result and captured calls. */
export interface MockFetchResult<T> {
  result: T;
  calls: CapturedFetchCall[];
}

/**
 * A fetch handler that receives a Request and returns a Response.
 * Can be async.
 */
export type FetchHandler = (
  request: Request,
) => Response | Promise<Response>;

/**
 * Runs a callback with `globalThis.fetch` replaced by a mock.
 *
 * The mock can be:
 * - A **Response array** — responses are returned sequentially, one per call
 * - A **handler function** — receives the Request and returns a Response
 *
 * All fetch calls are recorded and returned for inspection.
 * The original `fetch` is always restored, even if the callback throws.
 *
 * **Simple mode** — sequential responses:
 * ```typescript
 * import { withMockedFetch } from "@swamp-club/swamp-testing";
 *
 * const { result, calls } = await withMockedFetch([
 *   Response.json({ SecretString: "sk-test-123" }),
 * ], async () => {
 *   const provider = vault.createProvider("test", { region: "us-east-1" });
 *   return await provider.get("my-key");
 * });
 *
 * assertEquals(result, "sk-test-123");
 * assertEquals(calls.length, 1);
 * ```
 *
 * **Handler mode** — dynamic responses:
 * ```typescript
 * const { calls } = await withMockedFetch(async (req) => {
 *   const body = await req.json();
 *   if (body.SecretId) {
 *     return Response.json({ SecretString: "value" });
 *   }
 *   return Response.json({ SecretList: [] });
 * }, async () => {
 *   const provider = vault.createProvider("test", { region: "us-east-1" });
 *   await assertVaultConformance(provider);
 * });
 * ```
 */
export async function withMockedFetch<T>(
  handlerOrResponses: FetchHandler | Response[],
  fn: () => T | Promise<T>,
): Promise<MockFetchResult<T>> {
  const calls: CapturedFetchCall[] = [];
  let callIndex = 0;

  const isSequential = Array.isArray(handlerOrResponses);
  const responses = isSequential ? handlerOrResponses : null;
  const handler = isSequential ? null : handlerOrResponses;

  const originalFetch = globalThis.fetch;

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Normalize to a Request object
    const request = input instanceof Request ? input : new Request(input, init);

    // Capture the call
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let body: string | null = null;
    try {
      body = await request.clone().text();
    } catch {
      // Body may not be readable
    }

    calls.push({
      url: request.url,
      method: request.method,
      headers,
      body,
      timestamp: Date.now(),
    });

    // Return response
    if (responses) {
      if (callIndex >= responses.length) {
        throw new Error(
          `withMockedFetch: no more responses (got ${callIndex + 1} calls, ` +
            `only ${responses.length} responses queued). ` +
            `Last call: ${request.method} ${request.url}`,
        );
      }
      return responses[callIndex++].clone();
    }

    return await handler!(request);
  };

  globalThis.fetch = mockFetch as typeof fetch;

  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
