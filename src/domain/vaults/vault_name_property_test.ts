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
import fc from "fast-check";
import {
  isReservedVaultName,
  isValidVaultName,
  vaultCreateHint,
} from "./vault_name.ts";

/** Mixes valid names with arbitrary strings so both outcomes are exercised. */
const arbName = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
  fc.string({ maxLength: 20 }),
  fc.string({ maxLength: 20 }).map((s) => `_${s}`),
);

Deno.test("vaultCreateHint: suggests vault create with the name exactly when the name is valid", () => {
  fc.assert(
    fc.property(arbName, (name) => {
      const suggestsName = vaultCreateHint(name) ===
        `Create a vault using: swamp vault create <type> ${name}`;
      assertEquals(suggestsName, isValidVaultName(name));
    }),
  );
});

Deno.test("isReservedVaultName: a reserved name is never a valid vault name", () => {
  fc.assert(
    fc.property(arbName, (name) => {
      if (isReservedVaultName(name)) {
        assertEquals(isValidVaultName(name), false);
      }
    }),
  );
});
