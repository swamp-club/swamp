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

import { createHash, randomBytes } from "node:crypto";
import { timingSafeEqual } from "../crypto/timing_safe_equal.ts";

const SECRET_BYTES = 32;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newFederationSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function isFederationSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// compares digests, never raw secrets, so both sides have one length
export function matchesHash(presented: string, storedHash: string): boolean {
  return timingSafeEqual(sha256Hex(presented), storedHash);
}
