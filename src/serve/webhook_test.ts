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

import { assertEquals, assertThrows } from "@std/assert";
import { buildWebhookPayload, parseWebhookFlag } from "./webhook.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

// ── buildWebhookPayload ────────────────────────────────────────────────

Deno.test("buildWebhookPayload: parses a JSON body into webhook.body", () => {
  const body = new TextEncoder().encode(
    '{"data":{"issue":{"identifier":"PLT-1057"}}}',
  );
  const payload = buildWebhookPayload(body, new Headers(), "/hooks/linear");
  assertEquals(payload.body, {
    data: { issue: { identifier: "PLT-1057" } },
  });
  assertEquals(payload.route, "/hooks/linear");
});

Deno.test("buildWebhookPayload: falls back to the raw string for non-JSON", () => {
  const body = new TextEncoder().encode("not json at all");
  const payload = buildWebhookPayload(body, new Headers(), "/hooks/x");
  assertEquals(payload.body, "not json at all");
});

Deno.test("buildWebhookPayload: lowercases header names", () => {
  const headers = new Headers({ "X-Linear-Event": "Issue" });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/hooks/x",
  );
  assertEquals(payload.headers["x-linear-event"], "Issue");
});

Deno.test("buildWebhookPayload: drops the signature header", () => {
  const headers = new Headers({
    "X-Hub-Signature-256": "sha256=deadbeef",
    "X-Other": "keep",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/hooks/x",
  );
  assertEquals("x-hub-signature-256" in payload.headers, false);
  assertEquals(payload.headers["x-other"], "keep");
});

Deno.test("buildWebhookPayload: drops the scheme-specific signature header", () => {
  const headers = new Headers({
    "Stripe-Signature": "t=1,v1=deadbeef",
    "X-Hub-Signature-256": "sha256=keep-me",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/hooks/stripe",
    "stripe-signature",
  );
  // Only the active scheme's header is excluded; others pass through.
  assertEquals("stripe-signature" in payload.headers, false);
  assertEquals(payload.headers["x-hub-signature-256"], "sha256=keep-me");
});

// ── parseWebhookFlag ───────────────────────────────────────────────────

Deno.test("parseWebhookFlag: parses valid flag", () => {
  const result = parseWebhookFlag("/hooks/github:my-workflow:mysecret");
  assertEquals(result, {
    route: "/hooks/github",
    workflowIdOrName: "my-workflow",
    secret: "mysecret",
    verifier: { scheme: "github" },
  });
});

Deno.test("parseWebhookFlag: three-field form defaults to github", () => {
  const result = parseWebhookFlag("/hooks/gh:deploy:mysecret");
  assertEquals(result.verifier, { scheme: "github" });
});

Deno.test("parseWebhookFlag: secret can contain colons (legacy 3-field form)", () => {
  const result = parseWebhookFlag(
    "/hooks/gh:deploy:secret:with:colons",
  );
  assertEquals(result.route, "/hooks/gh");
  assertEquals(result.workflowIdOrName, "deploy");
  assertEquals(result.secret, "secret:with:colons");
  assertEquals(result.verifier, { scheme: "github" });
});

Deno.test("parseWebhookFlag: parses an explicit linear scheme", () => {
  const result = parseWebhookFlag("/hooks/linear:wf:mysecret:linear");
  assertEquals(result.secret, "mysecret");
  assertEquals(result.verifier, { scheme: "linear" });
});

Deno.test("parseWebhookFlag: parses stripe and slack schemes", () => {
  assertEquals(
    parseWebhookFlag("/hooks/s:wf:sec:stripe").verifier,
    { scheme: "stripe" },
  );
  assertEquals(
    parseWebhookFlag("/hooks/s:wf:sec:slack").verifier,
    { scheme: "slack" },
  );
});

Deno.test("parseWebhookFlag: parses generic scheme with header and prefix", () => {
  const result = parseWebhookFlag(
    "/hooks/x:wf:sec:generic:X-Signature:sha256=",
  );
  assertEquals(result.verifier, {
    scheme: "generic",
    header: "X-Signature",
    prefix: "sha256=",
  });
});

Deno.test("parseWebhookFlag: generic prefix defaults to empty", () => {
  const result = parseWebhookFlag("/hooks/x:wf:sec:generic:X-Signature");
  assertEquals(result.verifier, {
    scheme: "generic",
    header: "X-Signature",
    prefix: "",
  });
});

Deno.test("parseWebhookFlag: a non-scheme 4th field stays part of a colon-secret", () => {
  // 'nope' is not a known scheme, so the legacy interpretation wins: the secret
  // is everything after the 2nd colon and the scheme defaults to github.
  const result = parseWebhookFlag("/hooks/x:wf:sec:nope");
  assertEquals(result.secret, "sec:nope");
  assertEquals(result.verifier, { scheme: "github" });
});

Deno.test("parseWebhookFlag: rejects generic without a header", () => {
  assertThrows(
    () => parseWebhookFlag("/hooks/x:wf:sec:generic"),
    Error,
    "'generic' scheme requires a header",
  );
});

Deno.test("parseWebhookFlag: rejects missing first colon", () => {
  assertThrows(
    () => parseWebhookFlag("/hooks/github"),
    Error,
    "Invalid --webhook format",
  );
});

Deno.test("parseWebhookFlag: rejects missing second colon", () => {
  assertThrows(
    () => parseWebhookFlag("/hooks/github:my-workflow"),
    Error,
    "Invalid --webhook format",
  );
});

Deno.test("parseWebhookFlag: rejects empty route", () => {
  assertThrows(
    () => parseWebhookFlag(":my-workflow:secret"),
    Error,
    "must all be non-empty",
  );
});

Deno.test("parseWebhookFlag: rejects empty workflow", () => {
  assertThrows(
    () => parseWebhookFlag("/hooks/github::secret"),
    Error,
    "must all be non-empty",
  );
});

Deno.test("parseWebhookFlag: rejects empty secret", () => {
  assertThrows(
    () => parseWebhookFlag("/hooks/github:my-workflow:"),
    Error,
    "must all be non-empty",
  );
});

Deno.test("parseWebhookFlag: rejects route without leading slash", () => {
  assertThrows(
    () => parseWebhookFlag("hooks/github:my-workflow:secret"),
    Error,
    "must start with '/'",
  );
});
