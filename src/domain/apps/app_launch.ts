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

import {
  base64urlDecode,
  base64urlEncode,
} from "../auth/verification_proof.ts";
import { timingSafeEqual } from "../crypto/timing_safe_equal.ts";
import { AppNameSchema } from "./app_descriptor.ts";

/** The same span as `DASHBOARD_SESSION_TTL_MS`. */
export const APP_LAUNCH_TTL_MS = 8 * 60 * 60 * 1000;

/** Where serve answers for a launch's files: `/app-files/<launch-token>/<file>`. */
export const APP_FILES_PATH = "/app-files";

const TOKEN_VERSION = 1;
const STAMP_BYTES = 8;
const MAC_BYTES = 32;
// an app name is ASCII and at most 100 characters
const MAX_NAME_BYTES = 100;
// version, expiry in seconds, approval stamp, name length
const HEADER_BYTES = 1 + 4 + STAMP_BYTES + 1;
// the shortest app name is four characters, as in "@a/b"
const MIN_TOKEN_BYTES = HEADER_BYTES + 4 + MAC_BYTES;
const MAX_TOKEN_BYTES = HEADER_BYTES + MAX_NAME_BYTES + MAC_BYTES;

/** Anything else is not a launch token, so it is refused before any work. */
export const APP_LAUNCH_TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${Math.ceil(MIN_TOKEN_BYTES * 4 / 3)},${
    Math.ceil(MAX_TOKEN_BYTES * 4 / 3)
  }}$`,
);

// a key made for launches signs nothing else, but the label keeps it that way
const MAC_LABEL = new TextEncoder().encode("swamp-app-launch\0");

/** The key launch tokens are signed with; every instance must hold the same one. */
export interface AppLaunchKey {
  /** made when there is none yet */
  signing(): Promise<Uint8Array<ArrayBuffer>>;
  /** undefined when no key is usable, which refuses every token */
  verifying(): Promise<Uint8Array<ArrayBuffer> | undefined>;
}

export interface AppLaunchClaims {
  readonly name: string;
  readonly expiresAt: number;
  readonly approvalStamp: string;
}

/** Changes with each approval, so a launch dies with its approval even if the app is approved again. */
export async function appApprovalStamp(
  approval: { readonly capabilityKey: string; readonly approvedAt: string },
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${approval.capabilityKey}\n${approval.approvedAt}`,
    ),
  );
  return base64urlEncode(new Uint8Array(digest, 0, STAMP_BYTES));
}

function hmacKey(key: Uint8Array<ArrayBuffer>, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function labelled(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(MAC_LABEL.length + body.length);
  data.set(MAC_LABEL);
  data.set(body, MAC_LABEL.length);
  return data;
}

export async function mintAppLaunchToken(
  key: Uint8Array<ArrayBuffer>,
  claims: AppLaunchClaims,
): Promise<string> {
  const name = new TextEncoder().encode(AppNameSchema.parse(claims.name));
  const stamp = base64urlDecode(claims.approvalStamp);
  if (name.length > MAX_NAME_BYTES || stamp.length !== STAMP_BYTES) {
    throw new Error("A launch token cannot carry these claims");
  }
  const body = new Uint8Array(HEADER_BYTES + name.length);
  const view = new DataView(body.buffer);
  view.setUint8(0, TOKEN_VERSION);
  view.setUint32(1, Math.floor(claims.expiresAt / 1000));
  body.set(stamp, 5);
  view.setUint8(HEADER_BYTES - 1, name.length);
  body.set(name, HEADER_BYTES);
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(key, "sign"),
      labelled(body),
    ),
  );
  const token = new Uint8Array(body.length + MAC_BYTES);
  token.set(body);
  token.set(mac, body.length);
  return base64urlEncode(token);
}

function decode(token: string): Uint8Array<ArrayBuffer> | null {
  if (!APP_LAUNCH_TOKEN_PATTERN.test(token)) return null;
  try {
    const bytes = new Uint8Array(base64urlDecode(token));
    // one spelling per token, so trailing bits cannot vary a valid one
    return base64urlEncode(bytes) === token ? bytes : null;
  } catch {
    return null;
  }
}

/** Null for anything not signed with this key, expired, or malformed. */
export async function verifyAppLaunchToken(
  key: Uint8Array<ArrayBuffer>,
  token: string,
  now: number,
): Promise<AppLaunchClaims | null> {
  const bytes = decode(token);
  if (bytes === null || bytes.length < MIN_TOKEN_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== TOKEN_VERSION) return null;
  const nameLength = view.getUint8(HEADER_BYTES - 1);
  if (bytes.length !== HEADER_BYTES + nameLength + MAC_BYTES) return null;
  const body = bytes.subarray(0, HEADER_BYTES + nameLength);
  // WebCrypto's HMAC verify compares in constant time
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(key, "verify"),
    bytes.subarray(body.length),
    labelled(body),
  );
  if (!valid) return null;
  const expiresAt = view.getUint32(1) * 1000;
  if (expiresAt <= now) return null;
  const name = AppNameSchema.safeParse(
    new TextDecoder().decode(body.subarray(HEADER_BYTES)),
  );
  if (!name.success) return null;
  return {
    name: name.data,
    expiresAt,
    approvalStamp: base64urlEncode(body.slice(5, 5 + STAMP_BYTES)),
  };
}

export async function launchMatchesApproval(
  claims: AppLaunchClaims,
  approval: { readonly capabilityKey: string; readonly approvedAt: string },
): Promise<boolean> {
  return timingSafeEqual(
    claims.approvalStamp,
    await appApprovalStamp(approval),
  );
}
