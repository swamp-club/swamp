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

import type { WebhookHandler } from "../domain/webhooks/webhook_handler.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import {
  evaluateWebhookTypeTrust,
  untrustedWebhookSchemeMessage,
} from "../domain/webhooks/webhook_type_trust.ts";

const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type WebhookScheme =
  | "github"
  | "jira"
  | "linear"
  | "stripe"
  | "slack"
  | "generic";

export const WEBHOOK_SCHEMES: readonly WebhookScheme[] = [
  "github",
  "jira",
  "linear",
  "stripe",
  "slack",
  "generic",
];

export type ExtensionWebhookScheme = `@${string}/${string}`;

const EXTENSION_WEBHOOK_SCHEME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+$/;

export type BuiltinVerifierConfig =
  | { readonly scheme: "github" | "jira" | "linear" | "stripe" | "slack" }
  | {
    readonly scheme: "generic";
    readonly header: string;
    readonly prefix: string;
  };

export type VerifierConfig =
  | BuiltinVerifierConfig
  | {
    readonly scheme: ExtensionWebhookScheme;
    readonly config: Readonly<Record<string, unknown>>;
  };

export interface WebhookVerifier {
  readonly signatureHeader: string;
  readonly requiredHeaders: readonly string[];
  verify(
    body: Uint8Array,
    headers: Headers,
    secret: string,
  ): Promise<boolean>;
}

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
 * compares every character so timing does not leak how much of the digest
 * matched
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

function prefixedMessage(prefix: string, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(prefix);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

function timestampFresh(timestamp: number): boolean {
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - timestamp) <= TIMESTAMP_TOLERANCE_SECONDS;
}

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
 * stripe signs `<t>.<body>`; several v1 values appear during secret rotation,
 * so any match is valid
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

export function createVerifier(
  config: BuiltinVerifierConfig,
): WebhookVerifier {
  switch (config.scheme) {
    case "github":
      return prefixedBodyVerifier("x-hub-signature-256", "sha256=");
    case "jira":
      return prefixedBodyVerifier("x-hub-signature", "sha256=");
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

export function isWebhookScheme(value: string): value is WebhookScheme {
  return (WEBHOOK_SCHEMES as readonly string[]).includes(value);
}

export function isExtensionWebhookScheme(
  value: string,
): value is ExtensionWebhookScheme {
  return EXTENSION_WEBHOOK_SCHEME_PATTERN.test(value);
}

export type WebhookHandlerResolution =
  | { readonly kind: "ready"; readonly handler: WebhookHandler }
  | { readonly kind: "missing" }
  | { readonly kind: "untrusted"; readonly collective: string };

/** why a kept route's extension scheme could no longer serve, judged as delivery judges it */
export function webhookSchemeKeepRefusal(
  route: string,
  config: VerifierConfig,
  trustedCollectives: readonly string[],
): string | undefined {
  if (!("config" in config)) return undefined;
  const info = webhookTypeRegistry.get(config.scheme);
  if (!info) {
    return `its scheme '${config.scheme}' is no longer installed`;
  }
  const trust = evaluateWebhookTypeTrust(
    config.scheme,
    info.origin,
    trustedCollectives,
  );
  return trust.trusted
    ? undefined
    : untrustedWebhookSchemeMessage(route, config.scheme, trust.collective);
}

/**
 * extension handlers are looked up on every call so a SIGHUP reload takes
 * effect; trust is judged on the same registry entry that builds the handler,
 * so a reload cannot swap the entry between the decision and its use
 */
export function resolveWebhookHandler(
  config: VerifierConfig,
  trustedCollectives: readonly string[],
): WebhookHandlerResolution {
  if (!("config" in config)) {
    return { kind: "ready", handler: createVerifier(config) };
  }
  const info = webhookTypeRegistry.get(config.scheme);
  if (!info) return { kind: "missing" };
  const trust = evaluateWebhookTypeTrust(
    config.scheme,
    info.origin,
    trustedCollectives,
  );
  if (!trust.trusted) {
    return { kind: "untrusted", collective: trust.collective };
  }
  return { kind: "ready", handler: info.createHandler({ ...config.config }) };
}
