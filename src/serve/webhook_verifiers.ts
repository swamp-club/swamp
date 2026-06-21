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

/**
 * Pluggable webhook signature verification schemes (#716).
 *
 * Every supported provider authenticates with the same primitive — an
 * HMAC-SHA256 digest of a provider-specific message — and differs only in the
 * header it uses, how the digest is encoded in that header, and what bytes are
 * signed. This module hosts a closed, hardcoded set of schemes (github, linear,
 * stripe, slack, generic) over shared HMAC and constant-time-comparison
 * primitives. Each verifier is a stateless function of (body, headers, secret).
 *
 * Generalizing this into a data-driven/templated engine so new providers need
 * no swamp release is intentionally out of scope here and tracked in #723.
 */

/** Replay window for timestamped schemes (stripe, slack). */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

/** The closed set of supported verification schemes. */
export type WebhookScheme =
  | "github"
  | "linear"
  | "stripe"
  | "slack"
  | "generic";

/** Schemes selectable on the --webhook flag, in stable order. */
export const WEBHOOK_SCHEMES: readonly WebhookScheme[] = [
  "github",
  "linear",
  "stripe",
  "slack",
  "generic",
];

/**
 * Immutable verification config for a single endpoint. Only the `generic`
 * scheme carries extra parameters (the header to read and the value prefix to
 * strip); the named schemes are fully determined by their scheme tag.
 */
export type VerifierConfig =
  | { readonly scheme: "github" | "linear" | "stripe" | "slack" }
  | {
    readonly scheme: "generic";
    readonly header: string;
    readonly prefix: string;
  };

/**
 * A stateless signature verifier. `signatureHeader` is always lowercased so it
 * can be used both for the pre-body presence check and for exclusion from the
 * exposed webhook payload without a case mismatch.
 */
export interface WebhookVerifier {
  readonly signatureHeader: string;
  readonly requiredHeaders: readonly string[];
  verify(
    body: Uint8Array,
    headers: Headers,
    secret: string,
  ): Promise<boolean>;
}

// ── Shared primitives ──────────────────────────────────────────────────

/**
 * Compute the lowercase hex HMAC-SHA256 of `message` keyed by `secret`.
 */
export async function hmacSha256Hex(
  message: Uint8Array,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = message.buffer.slice(
    message.byteOffset,
    message.byteOffset + message.byteLength,
  ) as ArrayBuffer;
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two hex strings. Always compares every character
 * so timing does not leak how much of the digest matched.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Concatenate a leading UTF-8 string with the raw body bytes. */
function prefixedMessage(prefix: string, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(prefix);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** True when `timestamp` (unix seconds) is within the replay tolerance. */
function timestampFresh(timestamp: number): boolean {
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - timestamp) <= TIMESTAMP_TOLERANCE_SECONDS;
}

// ── Per-scheme verifiers ────────────────────────────────────────────────

/**
 * HMAC-over-body schemes that read a single header and strip a fixed prefix.
 * Covers github (`sha256=`), linear (bare), and generic (configurable).
 */
function prefixedBodyVerifier(
  signatureHeader: string,
  prefix: string,
): WebhookVerifier {
  return {
    signatureHeader,
    requiredHeaders: [signatureHeader],
    async verify(body, headers, secret) {
      const value = headers.get(signatureHeader);
      if (value === null || !value.startsWith(prefix)) {
        return false;
      }
      const received = value.slice(prefix.length);
      const expected = await hmacSha256Hex(body, secret);
      return constantTimeEqualHex(received, expected);
    },
  };
}

/**
 * Stripe: header `Stripe-Signature` carries `t=<unix>,v1=<hex>[,v1=<hex>...]`.
 * The signed message is `<t>.<body>`. Multiple v1 values appear during secret
 * rotation — the request is valid if any v1 matches.
 */
function stripeVerifier(): WebhookVerifier {
  const signatureHeader = "stripe-signature";
  return {
    signatureHeader,
    requiredHeaders: [signatureHeader],
    async verify(body, headers, secret) {
      const value = headers.get(signatureHeader);
      if (value === null) {
        return false;
      }

      let timestamp: string | undefined;
      const candidates: string[] = [];
      for (const part of value.split(",")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        if (k === "t") timestamp = v;
        else if (k === "v1") candidates.push(v);
      }

      if (timestamp === undefined || candidates.length === 0) {
        return false;
      }
      if (!timestampFresh(Number(timestamp))) {
        return false;
      }

      const expected = await hmacSha256Hex(
        prefixedMessage(`${timestamp}.`, body),
        secret,
      );
      // Compare against every candidate so timing does not reveal which (or
      // how many) signatures were present.
      let matched = false;
      for (const candidate of candidates) {
        if (constantTimeEqualHex(candidate, expected)) {
          matched = true;
        }
      }
      return matched;
    },
  };
}

/**
 * Slack: header `X-Slack-Signature` carries `v0=<hex>`, with the timestamp in
 * `X-Slack-Request-Timestamp`. The signed message is `v0:<timestamp>:<body>`.
 */
function slackVerifier(): WebhookVerifier {
  const signatureHeader = "x-slack-signature";
  const timestampHeader = "x-slack-request-timestamp";
  return {
    signatureHeader,
    requiredHeaders: [signatureHeader, timestampHeader],
    async verify(body, headers, secret) {
      const value = headers.get(signatureHeader);
      const timestamp = headers.get(timestampHeader);
      if (value === null || !value.startsWith("v0=") || timestamp === null) {
        return false;
      }
      if (!timestampFresh(Number(timestamp))) {
        return false;
      }
      const received = value.slice("v0=".length);
      const expected = await hmacSha256Hex(
        prefixedMessage(`v0:${timestamp}:`, body),
        secret,
      );
      return constantTimeEqualHex(received, expected);
    },
  };
}

/**
 * Build a verifier for the given config. The returned verifier's
 * `signatureHeader` is lowercased.
 */
export function createVerifier(config: VerifierConfig): WebhookVerifier {
  switch (config.scheme) {
    case "github":
      return prefixedBodyVerifier("x-hub-signature-256", "sha256=");
    case "linear":
      return prefixedBodyVerifier("linear-signature", "");
    case "stripe":
      return stripeVerifier();
    case "slack":
      return slackVerifier();
    case "generic":
      return prefixedBodyVerifier(
        config.header.toLowerCase(),
        config.prefix,
      );
  }
}

/** Type guard: is `value` one of the known scheme keywords? */
export function isWebhookScheme(value: string): value is WebhookScheme {
  return (WEBHOOK_SCHEMES as readonly string[]).includes(value);
}
