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

import { assertEquals } from "@std/assert";
import {
  createVerifier,
  hmacSha256Hex,
  isWebhookScheme,
} from "./webhook_verifiers.ts";

const SECRET = "test-secret";
const enc = (s: string) => new TextEncoder().encode(s);

/** Lowercase hex HMAC-SHA256 of a UTF-8 message — the reference computation. */
async function sign(message: string, secret = SECRET): Promise<string> {
  return await hmacSha256Hex(enc(message), secret);
}

/** Current unix time in seconds (inside the 300s tolerance window). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── github ──────────────────────────────────────────────────────────────

Deno.test("github verifier: accepts a valid signature", async () => {
  const verifier = createVerifier({ scheme: "github" });
  const body = '{"ref":"refs/heads/main"}';
  const headers = new Headers({
    "x-hub-signature-256": `sha256=${await sign(body)}`,
  });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), true);
});

Deno.test("github verifier: rejects a wrong secret", async () => {
  const verifier = createVerifier({ scheme: "github" });
  const body = "payload";
  const headers = new Headers({
    "x-hub-signature-256": `sha256=${await sign(body, "other")}`,
  });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), false);
});

Deno.test("github verifier: rejects a missing header", async () => {
  const verifier = createVerifier({ scheme: "github" });
  assertEquals(await verifier.verify(enc("x"), new Headers(), SECRET), false);
});

Deno.test("github verifier: rejects a tampered body", async () => {
  const verifier = createVerifier({ scheme: "github" });
  const headers = new Headers({
    "x-hub-signature-256": `sha256=${await sign("original")}`,
  });
  assertEquals(await verifier.verify(enc("tampered"), headers, SECRET), false);
});

Deno.test("github verifier: rejects a missing sha256= prefix", async () => {
  const verifier = createVerifier({ scheme: "github" });
  const headers = new Headers({
    "x-hub-signature-256": await sign("body"),
  });
  assertEquals(await verifier.verify(enc("body"), headers, SECRET), false);
});

Deno.test("github verifier: accepts an empty body", async () => {
  const verifier = createVerifier({ scheme: "github" });
  const headers = new Headers({
    "x-hub-signature-256": `sha256=${await sign("")}`,
  });
  assertEquals(await verifier.verify(enc(""), headers, SECRET), true);
});

Deno.test("github verifier: requiredHeaders contains only the signature header", () => {
  const verifier = createVerifier({ scheme: "github" });
  assertEquals(verifier.requiredHeaders, ["x-hub-signature-256"]);
});

// ── linear ──────────────────────────────────────────────────────────────

Deno.test("linear verifier: accepts a valid bare-hex signature", async () => {
  const verifier = createVerifier({ scheme: "linear" });
  assertEquals(verifier.signatureHeader, "linear-signature");
  const body = '{"action":"create"}';
  const headers = new Headers({ "linear-signature": await sign(body) });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), true);
});

Deno.test("linear verifier: rejects an invalid signature", async () => {
  const verifier = createVerifier({ scheme: "linear" });
  const headers = new Headers({ "linear-signature": "00".repeat(32) });
  assertEquals(await verifier.verify(enc("body"), headers, SECRET), false);
});

Deno.test("linear verifier: requiredHeaders contains only the signature header", () => {
  const verifier = createVerifier({ scheme: "linear" });
  assertEquals(verifier.requiredHeaders, ["linear-signature"]);
});

// ── generic ─────────────────────────────────────────────────────────────

Deno.test("generic verifier: lowercases the configured header", () => {
  const verifier = createVerifier({
    scheme: "generic",
    header: "X-Signature",
    prefix: "sha256=",
  });
  assertEquals(verifier.signatureHeader, "x-signature");
});

Deno.test("generic verifier: accepts a valid prefixed signature regardless of header case", async () => {
  const verifier = createVerifier({
    scheme: "generic",
    header: "X-Signature",
    prefix: "sha256=",
  });
  const body = "payload";
  // Request supplies the header in a different case — Headers is case-insensitive.
  const headers = new Headers({ "X-SIGNATURE": `sha256=${await sign(body)}` });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), true);
});

Deno.test("generic verifier: rejects a missing prefix", async () => {
  const verifier = createVerifier({
    scheme: "generic",
    header: "x-signature",
    prefix: "sha256=",
  });
  // Correct digest but no prefix present.
  const headers = new Headers({ "x-signature": await sign("payload") });
  assertEquals(await verifier.verify(enc("payload"), headers, SECRET), false);
});

Deno.test("generic verifier: empty prefix accepts a bare digest", async () => {
  const verifier = createVerifier({
    scheme: "generic",
    header: "x-signature",
    prefix: "",
  });
  const headers = new Headers({ "x-signature": await sign("payload") });
  assertEquals(await verifier.verify(enc("payload"), headers, SECRET), true);
});

Deno.test("generic verifier: requiredHeaders contains only the configured header", () => {
  const verifier = createVerifier({
    scheme: "generic",
    header: "X-My-Sig",
    prefix: "",
  });
  assertEquals(verifier.requiredHeaders, ["x-my-sig"]);
});

// ── stripe ──────────────────────────────────────────────────────────────

Deno.test("stripe verifier: accepts a fresh valid signature", async () => {
  const verifier = createVerifier({ scheme: "stripe" });
  const body = '{"id":"evt_1"}';
  const t = nowSeconds();
  const v1 = await sign(`${t}.${body}`);
  const headers = new Headers({ "stripe-signature": `t=${t},v1=${v1}` });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), true);
});

Deno.test("stripe verifier: accepts when any v1 matches (key rotation)", async () => {
  const verifier = createVerifier({ scheme: "stripe" });
  const body = "payload";
  const t = nowSeconds();
  const good = await sign(`${t}.${body}`);
  const headers = new Headers({
    "stripe-signature": `t=${t},v1=${"00".repeat(32)},v1=${good}`,
  });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), true);
});

Deno.test("stripe verifier: rejects a stale timestamp (replay)", async () => {
  const verifier = createVerifier({ scheme: "stripe" });
  const body = "payload";
  const t = nowSeconds() - 3600; // an hour old, well outside tolerance
  const v1 = await sign(`${t}.${body}`);
  const headers = new Headers({ "stripe-signature": `t=${t},v1=${v1}` });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), false);
});

Deno.test("stripe verifier: rejects a missing timestamp", async () => {
  const verifier = createVerifier({ scheme: "stripe" });
  const headers = new Headers({ "stripe-signature": `v1=${"ab".repeat(32)}` });
  assertEquals(await verifier.verify(enc("payload"), headers, SECRET), false);
});

Deno.test("stripe verifier: requiredHeaders contains only the signature header", () => {
  const verifier = createVerifier({ scheme: "stripe" });
  assertEquals(verifier.requiredHeaders, ["stripe-signature"]);
});

// ── slack ───────────────────────────────────────────────────────────────

Deno.test("slack verifier: accepts a fresh valid signature", async () => {
  const verifier = createVerifier({ scheme: "slack" });
  const body = "token=abc&team_id=T1";
  const ts = nowSeconds();
  const v0 = await sign(`v0:${ts}:${body}`);
  const headers = new Headers({
    "x-slack-signature": `v0=${v0}`,
    "x-slack-request-timestamp": String(ts),
  });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), true);
});

Deno.test("slack verifier: rejects a stale timestamp", async () => {
  const verifier = createVerifier({ scheme: "slack" });
  const body = "payload";
  const ts = nowSeconds() - 3600;
  const v0 = await sign(`v0:${ts}:${body}`);
  const headers = new Headers({
    "x-slack-signature": `v0=${v0}`,
    "x-slack-request-timestamp": String(ts),
  });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), false);
});

Deno.test("slack verifier: rejects a missing timestamp header", async () => {
  const verifier = createVerifier({ scheme: "slack" });
  const body = "payload";
  const v0 = await sign(`v0:${nowSeconds()}:${body}`);
  const headers = new Headers({ "x-slack-signature": `v0=${v0}` });
  assertEquals(await verifier.verify(enc(body), headers, SECRET), false);
});

Deno.test("slack verifier: requiredHeaders includes both signature and timestamp", () => {
  const verifier = createVerifier({ scheme: "slack" });
  assertEquals(verifier.requiredHeaders, [
    "x-slack-signature",
    "x-slack-request-timestamp",
  ]);
});

// ── isWebhookScheme ─────────────────────────────────────────────────────

Deno.test("isWebhookScheme: recognizes known schemes", () => {
  assertEquals(isWebhookScheme("github"), true);
  assertEquals(isWebhookScheme("generic"), true);
});

Deno.test("isWebhookScheme: rejects unknown schemes", () => {
  assertEquals(isWebhookScheme("service_butthole"), false);
  assertEquals(isWebhookScheme(""), false);
});
