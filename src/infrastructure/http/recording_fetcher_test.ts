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

import { assertEquals, assertRejects } from "@std/assert";
import {
  createApiCallRecorder,
  recordingFetcher,
} from "./recording_fetcher.ts";

const REGISTRY = "https://swamp-club.test";

Deno.test("recordingFetcher: records each response by service with its outcome and status", async () => {
  const recorder = createApiCallRecorder();
  const fetcher = recordingFetcher(recorder, REGISTRY, (url) => {
    const u = new URL(String(url));
    const status = u.host === "api.osv.dev"
      ? 500
      : u.pathname.endsWith("/missing")
      ? 404
      : 200;
    return Promise.resolve(new Response("", { status }));
  });

  await fetcher(`${REGISTRY}/api/whoami`, {
    headers: { "x-api-key": "s3cret" },
  });
  await fetcher(`${REGISTRY}/api/v1/extensions/x/missing`);
  await fetcher("https://api.osv.dev/v1/query", { method: "post" });
  await fetcher(new URL("https://registry.npmjs.org/zod"));

  assertEquals(recorder.calls, [
    {
      service: "registry",
      method: "GET",
      url: `${REGISTRY}/api/whoami`,
      outcome: "ok",
      status: 200,
    },
    {
      service: "registry",
      method: "GET",
      url: `${REGISTRY}/api/v1/extensions/x/missing`,
      outcome: "not-found",
      status: 404,
    },
    {
      service: "osv",
      method: "POST",
      url: "https://api.osv.dev/v1/query",
      outcome: "error",
      status: 500,
    },
    {
      service: "npm",
      method: "GET",
      url: "https://registry.npmjs.org/zod",
      outcome: "ok",
      status: 200,
    },
  ]);
});

Deno.test("recordingFetcher: a request that throws is recorded as an error and rethrown", async () => {
  const recorder = createApiCallRecorder();
  const fetcher = recordingFetcher(
    recorder,
    REGISTRY,
    () => Promise.reject(new TypeError("connection refused")),
  );

  await assertRejects(
    () => fetcher(`${REGISTRY}/api/whoami`),
    TypeError,
    "connection refused",
  );
  assertEquals(recorder.calls, [
    {
      service: "registry",
      method: "GET",
      url: `${REGISTRY}/api/whoami`,
      outcome: "error",
    },
  ]);
});

Deno.test("recordingFetcher: strips userinfo from the recorded URL", async () => {
  const recorder = createApiCallRecorder();
  const fetcher = recordingFetcher(
    recorder,
    "https://user:pass@swamp-club.test",
    () => Promise.resolve(new Response("", { status: 200 })),
  );
  await fetcher("https://user:pass@swamp-club.test/api/whoami");
  assertEquals(recorder.calls[0].url, "https://swamp-club.test/api/whoami");
  assertEquals(recorder.calls[0].service, "registry");
});

Deno.test("recordingFetcher: records carry no headers", async () => {
  const recorder = createApiCallRecorder();
  const fetcher = recordingFetcher(
    recorder,
    REGISTRY,
    () => Promise.resolve(new Response("", { status: 200 })),
  );
  await fetcher(`${REGISTRY}/api/whoami`, {
    headers: { authorization: "Bearer token" },
  });
  assertEquals(
    Object.keys(recorder.calls[0]).sort(),
    ["method", "outcome", "service", "status", "url"],
  );
  assertEquals(JSON.stringify(recorder.calls).includes("token"), false);
});
