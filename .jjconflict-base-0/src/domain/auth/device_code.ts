// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** Characters excluding ambiguous glyphs (0, O, 1, I, L). */
const SAFE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Generate a device verification code in XXXX-XXXX format. */
export function generateDeviceCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => SAFE_CHARS[b % SAFE_CHARS.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
