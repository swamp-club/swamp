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

import { assertEquals, assertThrows } from "@std/assert";
import {
  isIssuedEntry,
  SecretBagRegistry,
  SENTINEL_EXACT,
} from "./secret_bag_registry.ts";

const PREFIX = "0123456789abcdef".repeat(2);
const sentinel = (n: number, prefix = PREFIX) =>
  `__SWAMP_VSEC_${prefix}_${n}__`;
const REF = { vaultName: "v", key: "k" };

Deno.test("SecretBagRegistry.register: an entry is found by its sentinel, issued or shipped", () => {
  const registry = new SecretBagRegistry();
  registry.register({
    sentinel: sentinel(0),
    value: "one",
    reference: REF,
    encoding: "raw",
    dataOrigin: false,
  });
  registry.register({ sentinel: sentinel(1), value: "two", dataOrigin: true });
  assertEquals(registry.entryOf(sentinel(0))?.value, "one");
  assertEquals(registry.issuedEntryOf(sentinel(0))?.reference, REF);
  assertEquals(registry.entryOf(sentinel(1))?.dataOrigin, true);
  assertEquals(registry.issuedEntryOf(sentinel(1)), undefined);
  assertEquals(isIssuedEntry(registry.entryOf(sentinel(1))!), false);
  assertEquals(registry.entryOf(sentinel(2)), undefined);
  assertEquals([...registry.all()].map((e) => e.value), ["one", "two"]);
});

Deno.test("SecretBagRegistry.register: a sentinel is registered once", () => {
  const registry = new SecretBagRegistry();
  registry.register({ sentinel: sentinel(0), value: "a", dataOrigin: false });
  assertThrows(
    () =>
      registry.register({
        sentinel: sentinel(0),
        value: "b",
        dataOrigin: false,
      }),
    Error,
    "issued twice",
  );
  assertEquals(registry.entryOf(sentinel(0))?.value, "a");
});

Deno.test("SecretBagRegistry.register: refuses text that is not a sentinel", () => {
  const registry = new SecretBagRegistry();
  for (const bad of ["$(id)", "__SWAMP_VSEC_deadbeef_0__", sentinel(0) + "x"]) {
    assertThrows(
      () => registry.register({ sentinel: bad, value: "x", dataOrigin: false }),
      Error,
      "Malformed",
    );
  }
  assertEquals(registry.isEmpty, true);
});

Deno.test("SecretBagRegistry.drewPrefixOf: only prefixes its bags drew or its entries carry", () => {
  const registry = new SecretBagRegistry();
  assertEquals(registry.drewPrefixOf(sentinel(0)), false);
  registry.drawPrefix(PREFIX);
  assertEquals(registry.drewPrefixOf(sentinel(7)), true);
  assertEquals(registry.entryOf(sentinel(7)), undefined);
  const other = "f".repeat(32);
  assertEquals(registry.drewPrefixOf(sentinel(0, other)), false);
  registry.register({
    sentinel: sentinel(0, other),
    value: "shipped",
    dataOrigin: false,
  });
  assertEquals(registry.drewPrefixOf(sentinel(3, other)), true);
  assertEquals(registry.drewPrefixOf("not a sentinel"), false);
});

Deno.test("SENTINEL_EXACT: a 32-hex prefix and a counter, nothing else", () => {
  assertEquals(SENTINEL_EXACT.test(sentinel(12)), true);
  assertEquals(
    SENTINEL_EXACT.test(`__SWAMP_VSEC_${"a".repeat(31)}_0__`),
    false,
  );
  assertEquals(
    SENTINEL_EXACT.test(`__SWAMP_VSEC_${"A".repeat(32)}_0__`),
    false,
  );
  assertEquals(SENTINEL_EXACT.test(` ${sentinel(0)}`), false);
});
