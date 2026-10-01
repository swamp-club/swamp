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

import { assert, assertEquals } from "@std/assert";
import { EMBEDDED_PUBLIC_KEY } from "./embedded_public_key.ts";
import { base64urlDecode } from "./verification_proof.ts";

Deno.test("EMBEDDED_PUBLIC_KEY: is a raw 32-byte Ed25519 public key", async () => {
  assert(
    EMBEDDED_PUBLIC_KEY,
    "a signin token cannot verify offline without it",
  );
  const bytes = base64urlDecode(EMBEDDED_PUBLIC_KEY);
  assertEquals(bytes.length, 32);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.buffer as ArrayBuffer,
    "Ed25519",
    false,
    ["verify"],
  );
  assertEquals(key.algorithm.name, "Ed25519");
});
