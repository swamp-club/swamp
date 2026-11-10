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

export interface Sent {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

export type Answer =
  | {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    text?: string;
  }
  | "network_error"
  | "connection_refused"
  | "hang";

/** a fetch that answers from a script and records what it was sent */
export function scriptedFetch(answers: Answer[] | ((sent: Sent) => Answer)): {
  fetch: typeof fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const queue = Array.isArray(answers) ? [...answers] : undefined;
  const fake = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const record: Sent = {
      url: String(input),
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    sent.push(record);
    const answer = queue ? queue.shift() : (answers as (s: Sent) => Answer)(
      record,
    );
    if (answer === undefined) throw new Error("no scripted answer left");
    if (answer === "network_error") {
      return Promise.reject(new TypeError(`fetch failed: ${record.url}`));
    }
    if (answer === "connection_refused") {
      return Promise.reject(
        new TypeError("fetch failed", {
          cause: new Error(
            `error sending request for url (${record.url}): client error (Connect): tcp connect error: Connection refused (os error 61)`,
          ),
        }),
      );
    }
    if (answer === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
      });
    }
    const body = answer.text ?? JSON.stringify(answer.body ?? {});
    return Promise.resolve(
      new Response(body, {
        status: answer.status,
        headers: {
          ...(answer.text === undefined
            ? { "content-type": "application/json" }
            : { "content-type": "text/plain" }),
          ...answer.headers,
        },
      }),
    );
  };
  return { fetch: fake as typeof fetch, sent };
}

export const SERVE = "http://serve.test";
/** retries without waiting */
export const FAST = { random: () => 0, maxRetryWaitMs: 60_000 };
