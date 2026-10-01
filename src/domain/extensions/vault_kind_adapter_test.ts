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
import { vaultKindAdapter } from "./vault_kind_adapter.ts";

Deno.test("vaultKindAdapter.extractTypeFromSource: reads type from export const vault", () => {
  const result = vaultKindAdapter.extractTypeFromSource(
    'export const vault = {\n  type: "@Test/Vault",\n};',
  );
  assertEquals(result?.typeNormalized, "@test/vault");
  assertEquals(result?.kind, "vault");
});

Deno.test("vaultKindAdapter.extractTypeFromSource: ignores a declaration inside a string fixture (swamp-club#2876)", () => {
  assertEquals(
    vaultKindAdapter.extractTypeFromSource(
      "const src = 'export const vault = { type: \"@acme/thing\" }';",
    ),
    null,
  );
});
