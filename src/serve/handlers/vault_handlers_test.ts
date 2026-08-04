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
import { isReservedVaultName } from "./vault_handlers.ts";

Deno.test("isReservedVaultName: returns true for _token-secrets", () => {
  assertEquals(isReservedVaultName("_token-secrets"), true);
});

Deno.test("isReservedVaultName: returns true for _any-underscore-prefix", () => {
  assertEquals(isReservedVaultName("_any-underscore-prefix"), true);
});

Deno.test("isReservedVaultName: returns false for normal vault names", () => {
  assertEquals(isReservedVaultName("default"), false);
  assertEquals(isReservedVaultName("my-vault"), false);
  assertEquals(isReservedVaultName("production"), false);
});

Deno.test("isReservedVaultName: returns false for empty string", () => {
  assertEquals(isReservedVaultName(""), false);
});
