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
import { isVaultExistenceProvider } from "./vault_provider.ts";

Deno.test("isVaultExistenceProvider: true for an object with a has function", () => {
  assertEquals(
    isVaultExistenceProvider({ has: () => Promise.resolve(true) }),
    true,
  );
});

Deno.test("isVaultExistenceProvider: false for a provider without has", () => {
  assertEquals(
    isVaultExistenceProvider({
      get: () => Promise.resolve("v"),
      put: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      getName: () => "plain",
    }),
    false,
  );
});

Deno.test("isVaultExistenceProvider: false when has is not a function", () => {
  assertEquals(isVaultExistenceProvider({ has: true }), false);
});

Deno.test("isVaultExistenceProvider: false for null and non-objects", () => {
  assertEquals(isVaultExistenceProvider(null), false);
  assertEquals(isVaultExistenceProvider(undefined), false);
  assertEquals(isVaultExistenceProvider("has"), false);
  assertEquals(isVaultExistenceProvider(42), false);
});
