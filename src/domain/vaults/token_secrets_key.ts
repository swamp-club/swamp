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

import { UserError } from "../errors.ts";

/**
 * The operator-supplied key that encrypts `_token-secrets` when serve is
 * opted in to an external key (serve.yaml `token-secrets`). The key lives in a
 * vault outside the datastore; the control plane only ever holds a
 * {@link TokenKeyMarker} recording which key was used.
 */

/** Length of an AES-256 key in bytes. */
export const TOKEN_SECRETS_KEY_BYTES = 32;

/**
 * A problem with the external token key or its configuration. The message
 * already says what to fix, so callers report it as is rather than adding
 * datastore hints.
 */
export class TokenSecretsKeyError extends UserError {}

/** Where the operator stores the external key: a vault name and secret key. */
export interface TokenSecretsKeyRef {
  readonly vault: string;
  readonly key: string;
}

const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes operator-supplied key material. Accepts exactly 64 hex characters,
 * or base64 (padded or not) that decodes to exactly 32 bytes (e.g.
 * `openssl rand -base64 32`).
 * Rejects any other length or encoding, and keys whose bytes are all the same.
 * Error messages never include the value.
 */
export function parseTokenSecretsKeyMaterial(value: string): Uint8Array {
  const trimmed = value.trim();
  let bytes: Uint8Array | undefined;
  if (HEX_KEY_PATTERN.test(trimmed)) {
    bytes = new Uint8Array(TOKEN_SECRETS_KEY_BYTES);
    for (let i = 0; i < TOKEN_SECRETS_KEY_BYTES; i++) {
      bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
  } else if (BASE64_PATTERN.test(trimmed) && trimmed.length % 4 !== 1) {
    // Accept unpadded base64 too; some generators strip the '=' padding.
    const binary = atob(trimmed.padEnd(Math.ceil(trimmed.length / 4) * 4, "="));
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  }

  if (!bytes) {
    throw new TokenSecretsKeyError(
      "Token secrets key is not valid hex or base64. Generate one with " +
        "'openssl rand -base64 32'.",
    );
  }
  if (bytes.length !== TOKEN_SECRETS_KEY_BYTES) {
    throw new TokenSecretsKeyError(
      `Token secrets key must decode to ${TOKEN_SECRETS_KEY_BYTES} bytes, ` +
        `got ${bytes.length}. Generate one with 'openssl rand -base64 32'.`,
    );
  }
  if (bytes.every((b) => b === bytes[0])) {
    throw new TokenSecretsKeyError(
      "Token secrets key has the same value in every byte. Generate a random " +
        "key with 'openssl rand -base64 32'.",
    );
  }
  return bytes;
}

const FINGERPRINT_LABEL = "swamp token-secrets key fingerprint v1";

/**
 * Identifies a key without revealing it: HMAC-SHA256 keyed by the key over a
 * fixed label, as hex. Instances compare fingerprints to prove they hold the
 * same key; the fingerprint cannot decrypt anything.
 */
export async function tokenKeyFingerprint(key: Uint8Array): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(
      key.byteOffset,
      key.byteOffset + key.byteLength,
    ) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(FINGERPRINT_LABEL),
  );
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const MARKER_FORMAT = "swamp-token-key-marker";

/**
 * Stored in place of the co-located key once `_token-secrets` uses an external
 * key. `vault` and `key` record where the key was configured, for error
 * messages only — nothing resolves a key from them, because the control plane
 * is datastore content and must not choose the key source.
 */
export interface TokenKeyMarker {
  readonly vault: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly migratedAt: string;
}

/**
 * Serializes a marker as JSON. The output is always longer than an AES key, so
 * a swamp version without external-key support fails to import it as a key
 * and refuses to start instead of generating a new co-located key.
 */
export function serializeTokenKeyMarker(marker: TokenKeyMarker): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    format: MARKER_FORMAT,
    version: 1,
    vault: marker.vault,
    key: marker.key,
    fingerprint: marker.fingerprint,
    migratedAt: marker.migratedAt,
  }));
}

/** What the control plane holds at the token-secrets key path. */
export type TokenKeyRecord =
  | { readonly kind: "absent" }
  | { readonly kind: "legacy"; readonly key: Uint8Array }
  | { readonly kind: "marker"; readonly marker: TokenKeyMarker };

/**
 * Classifies the token-secrets key record. A 32-byte record is the legacy
 * co-located key; a marker is recognised by its format field. Anything else is
 * corrupt and throws rather than being treated as absent, which would
 * generate a fresh key over it.
 */
export function classifyTokenKeyRecord(
  data: Uint8Array | null,
): TokenKeyRecord {
  if (data === null) return { kind: "absent" };
  if (data.length === TOKEN_SECRETS_KEY_BYTES) {
    return { kind: "legacy", key: new Uint8Array(data) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    parsed = undefined;
  }
  const obj = parsed as Record<string, unknown> | undefined;
  if (
    obj !== null && typeof obj === "object" &&
    obj.format === MARKER_FORMAT && obj.version === 1 &&
    typeof obj.vault === "string" && obj.vault.length > 0 &&
    typeof obj.key === "string" && obj.key.length > 0 &&
    typeof obj.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(obj.fingerprint) &&
    typeof obj.migratedAt === "string"
  ) {
    return {
      kind: "marker",
      marker: {
        vault: obj.vault,
        key: obj.key,
        fingerprint: obj.fingerprint,
        migratedAt: obj.migratedAt,
      },
    };
  }

  throw new Error(
    `Token encryption key record is unrecognized (${data.length} bytes): ` +
      "it is neither a key nor an external-key marker",
  );
}
