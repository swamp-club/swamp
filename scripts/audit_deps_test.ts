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

// These tests are the only automated coverage this script has: `scripts/` is
// excluded from `deno fmt` and `deno lint` in deno.json, and `deno task check`
// only type-checks the main.ts graph.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { fetchVulnDetails, formatVuln } from "./audit_deps.ts";

/** Captures console.warn output for the duration of `run`. */
async function captureWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

/** Rejects with the signal's reason once `signal` aborts. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** The id at the end of a `/v1/vulns/{id}` request URL, decoded. */
function requestedId(request: Request): string {
  const path = new URL(request.url).pathname;
  return decodeURIComponent(path.substring("/v1/vulns/".length));
}

Deno.test("formatVuln: uses the summary and CVE aliases", () => {
  assertEquals(
    formatVuln({
      id: "GHSA-p6mc-m468-83gw",
      summary: "Prototype Pollution in lodash",
      aliases: ["CVE-2020-8203", "SNYK-JS-LODASH-590103"],
    }),
    "GHSA-p6mc-m468-83gw (CVE-2020-8203): Prototype Pollution in lodash",
  );
});

Deno.test("formatVuln: falls back to the first non-empty line of details", () => {
  assertEquals(
    formatVuln({
      id: "GHSA-aaaa-bbbb-cccc",
      summary: "  ",
      details: "\n\n  First real line.  \nSecond line.",
    }),
    "GHSA-aaaa-bbbb-cccc: First real line.",
  );
});

Deno.test("formatVuln: says no description is available when there is none", () => {
  assertEquals(
    formatVuln({ id: "GHSA-aaaa-bbbb-cccc" }),
    "GHSA-aaaa-bbbb-cccc: No description available",
  );
});

Deno.test("fetchVulnDetails: fetches each unique id once and returns full records", async () => {
  const { result, calls } = await withMockedFetch(
    (request) =>
      Response.json({
        id: requestedId(request),
        summary: `summary of ${requestedId(request)}`,
      }),
    () => fetchVulnDetails(["GHSA-1", "GHSA-2", "GHSA-1", "GHSA-2", "GHSA-1"]),
  );

  assertEquals(
    calls.map((c) => c.url).sort(),
    [
      "https://api.osv.dev/v1/vulns/GHSA-1",
      "https://api.osv.dev/v1/vulns/GHSA-2",
    ],
  );
  assertEquals(calls.every((c) => c.method === "GET"), true);
  assertEquals(result.get("GHSA-1")?.summary, "summary of GHSA-1");
  assertEquals(result.get("GHSA-2")?.summary, "summary of GHSA-2");
});

Deno.test("fetchVulnDetails: percent-encodes the id in the request path", async () => {
  const { calls } = await withMockedFetch(
    () => Response.json({ id: "x" }),
    () => fetchVulnDetails(["../querybatch?x=1"]),
  );

  assertEquals(
    calls[0].url,
    "https://api.osv.dev/v1/vulns/..%2Fquerybatch%3Fx%3D1",
  );
});

Deno.test("fetchVulnDetails: a failed lookup warns and omits only that id", async () => {
  const { result: { result, warnings } } = await withMockedFetch(
    (request) => {
      const id = requestedId(request);
      if (id === "GHSA-missing") {
        return new Response("not found", { status: 404 });
      }
      if (id === "GHSA-broken") throw new TypeError("connection reset");
      return Response.json({ id, summary: "ok" });
    },
    () =>
      captureWarnings(() =>
        fetchVulnDetails(["GHSA-missing", "GHSA-good", "GHSA-broken"])
      ),
  );

  assertEquals([...result.keys()], ["GHSA-good"]);
  assertEquals(warnings.length, 2);
  assertStringIncludes(
    warnings.join("\n"),
    "GHSA-missing: OSV API returned 404",
  );
  assertStringIncludes(warnings.join("\n"), "GHSA-broken: connection reset");
});

Deno.test("fetchVulnDetails: a lookup that exceeds the timeout is abandoned", async () => {
  const { result: { result, warnings } } = await withMockedFetch(
    (request) => {
      const id = requestedId(request);
      // Answers only once the request is aborted, so without a timeout this
      // lookup would never finish.
      if (id === "GHSA-slow") return whenAborted(request.signal);
      return Response.json({ id, summary: "ok" });
    },
    () =>
      captureWarnings(() =>
        fetchVulnDetails(["GHSA-slow", "GHSA-fast"], { timeoutMs: 50 })
      ),
  );

  assertEquals([...result.keys()], ["GHSA-fast"]);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "GHSA-slow");
});

Deno.test("fetchVulnDetails: runs exactly `concurrency` lookups at once", async () => {
  const concurrency = 4;
  const ids = Array.from({ length: 20 }, (_, i) => `GHSA-${i}`);
  let inFlight = 0;
  let peak = 0;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => openGate = resolve);

  const { result, calls } = await withMockedFetch(
    async (request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (inFlight === concurrency) openGate();
      try {
        // Held until the pool has filled. If it never fills, the request's
        // timeout settles it, so a serial pool fails the assertions below
        // instead of hanging the test.
        await Promise.race([gate, whenAborted(request.signal)]);
        return Response.json({ id: requestedId(request) });
      } finally {
        inFlight--;
      }
    },
    () => fetchVulnDetails(ids, { concurrency, timeoutMs: 1_000 }),
  );

  assertEquals(peak, concurrency);
  assertEquals(result.size, ids.length);
  assertEquals(calls.length, ids.length);
  assert(new Set(calls.map((c) => c.url)).size === ids.length);
});
