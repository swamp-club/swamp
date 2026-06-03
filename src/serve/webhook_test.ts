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
import { parseWebhookFlag, verifySignature } from "./webhook.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

// ── parseWebhookFlag ───────────────────────────────────────────────────

Deno.test("parseWebhookFlag: parses valid flag", () => {
  const result = parseWebhookFlag("/hooks/github:my-workflow:mysecret");
  assertEquals(result, {
    route: "/hooks/github",
    workflowIdOrName: "my-workflow",
    secret: "mysecret",
  });
});

Deno.test("parseWebhookFlag: secret can contain colons", () => {
  const result = parseWebhookFlag(
    "/hooks/gh:deploy:secret:with:colons",
  );
  assertEquals(result.route, "/hooks/gh");
  assertEquals(result.workflowIdOrName, "deploy");
  assertEquals(result.secret, "secret:with:colons");
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

// ── verifySignature ────────────────────────────────────────────────────

async function computeSignature(
  body: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

Deno.test("verifySignature: accepts valid signature", async () => {
  const body = '{"ref":"refs/heads/main"}';
  const secret = "test-secret";
  const sig = await computeSignature(body, secret);

  const result = await verifySignature(
    new TextEncoder().encode(body),
    sig,
    secret,
  );
  assertEquals(result, true);
});

Deno.test("verifySignature: rejects invalid signature", async () => {
  const body = '{"ref":"refs/heads/main"}';
  const secret = "test-secret";

  const result = await verifySignature(
    new TextEncoder().encode(body),
    "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    secret,
  );
  assertEquals(result, false);
});

Deno.test("verifySignature: rejects wrong secret", async () => {
  const body = '{"ref":"refs/heads/main"}';
  const sig = await computeSignature(body, "correct-secret");

  const result = await verifySignature(
    new TextEncoder().encode(body),
    sig,
    "wrong-secret",
  );
  assertEquals(result, false);
});

Deno.test("verifySignature: rejects missing sha256= prefix", async () => {
  const result = await verifySignature(
    new TextEncoder().encode("body"),
    "not-a-valid-header",
    "secret",
  );
  assertEquals(result, false);
});

Deno.test("verifySignature: rejects empty signature header", async () => {
  const result = await verifySignature(
    new TextEncoder().encode("body"),
    "",
    "secret",
  );
  assertEquals(result, false);
});

Deno.test("verifySignature: works with empty body", async () => {
  const body = "";
  const secret = "test-secret";
  const sig = await computeSignature(body, secret);

  const result = await verifySignature(
    new TextEncoder().encode(body),
    sig,
    secret,
  );
  assertEquals(result, true);
});

Deno.test("verifySignature: rejects tampered body", async () => {
  const secret = "test-secret";
  const sig = await computeSignature("original body", secret);

  const result = await verifySignature(
    new TextEncoder().encode("tampered body"),
    sig,
    secret,
  );
  assertEquals(result, false);
});
