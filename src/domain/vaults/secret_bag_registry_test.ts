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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  holdsValue,
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
    reference: REF,
    encoding: "raw",
    dataOrigin: false,
    location: "loc",
  });
  registry.register({ sentinel: sentinel(1), value: "two", dataOrigin: true });
  registry.register({
    sentinel: sentinel(2),
    value: "three",
    reference: REF,
    encoding: "json",
    dataOrigin: true,
  });
  assertEquals(holdsValue(registry.entryOf(sentinel(0))!), false);
  assertEquals(registry.issuedEntryOf(sentinel(0))?.reference, REF);
  assertEquals(registry.entryOf(sentinel(1))?.dataOrigin, true);
  assertEquals(registry.issuedEntryOf(sentinel(1)), undefined);
  assertEquals(isIssuedEntry(registry.entryOf(sentinel(1))!), false);
  assertEquals(registry.issuedEntryOf(sentinel(2))?.encoding, "json");
  assertEquals(registry.entryOf(sentinel(3)), undefined);
  assertEquals(
    [...registry.all()].map((e) => holdsValue(e) ? e.value : undefined),
    [undefined, "two", "three"],
  );
});

Deno.test("SecretBagRegistry.confirmExists: concurrent callers share one answer, and a confirmation is kept", async () => {
  const registry = new SecretBagRegistry();
  let asked = 0;
  const ask = () => {
    asked++;
    return Promise.resolve();
  };
  await Promise.all([
    registry.confirmExists(REF, ask),
    registry.confirmExists(REF, ask),
    registry.confirmExists({ vaultName: "v", key: "other" }, ask),
  ]);
  await registry.confirmExists(REF, ask);
  assertEquals(asked, 2);
});

Deno.test("SecretBagRegistry.confirmExists: a rejection is shared while in flight, then asked again", async () => {
  const registry = new SecretBagRegistry();
  let asked = 0;
  const failing = () => {
    asked++;
    return Promise.reject(new Error("missing"));
  };
  const results = await Promise.allSettled([
    registry.confirmExists(REF, failing),
    registry.confirmExists(REF, failing),
  ]);
  assertEquals(results.map((r) => r.status), ["rejected", "rejected"]);
  assertEquals(asked, 1);
  await assertRejects(() => registry.confirmExists(REF, failing), "missing");
  assertEquals(asked, 2);
  await registry.confirmExists(REF, () => Promise.resolve());
  await registry.confirmExists(REF, failing);
  assertEquals(asked, 2);
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
  assertEquals((registry.entryOf(sentinel(0)) as { value: string }).value, "a");
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

Deno.test("SecretBagRegistry: a data-origin reference entry is issued, holds no value, and reads as data origin", () => {
  const registry = new SecretBagRegistry();
  registry.register({
    sentinel: sentinel(0),
    reference: REF,
    encoding: "raw",
    dataOrigin: true,
    location:
      "data.latest of model 'db' record r1 version 1 (data.latest), field 'k'",
  });
  const entry = registry.issuedEntryOf(sentinel(0))!;
  assertEquals(isIssuedEntry(entry), true);
  assertEquals(holdsValue(entry), false);
  assertEquals(entry.dataOrigin, true);
  assertEquals("value" in entry, false);
});

Deno.test("SecretBagRegistry.typedSecrets: off unless asked for, the internal option only tests set (typed-secrets 3.4)", () => {
  assertEquals(new SecretBagRegistry().typedSecrets, false);
  assertEquals(new SecretBagRegistry({}).typedSecrets, false);
  assertEquals(
    new SecretBagRegistry({ typedSecrets: true }).typedSecrets,
    true,
  );
});

Deno.test("SecretBagRegistry.independent: a new registry carries the option and nothing else", async () => {
  for (const typed of [true, false]) {
    const registry = new SecretBagRegistry({ typedSecrets: typed });
    registry.register({
      sentinel: sentinel(0),
      reference: REF,
      encoding: "raw",
      dataOrigin: false,
      location: "loc",
    });
    let asked = 0;
    const ask = () => {
      asked++;
      return Promise.resolve();
    };
    await registry.confirmExists(REF, ask);
    const nested = registry.independent();
    assertEquals(nested.typedSecrets, typed);
    assertEquals(nested.isEmpty, true);
    assertEquals(nested.entryOf(sentinel(0)), undefined);
    assertEquals(nested.drewPrefixOf(sentinel(0)), false);
    // The parent's answer is not reused: the nested registry asks again.
    await nested.confirmExists(REF, ask);
    assertEquals(asked, 2);
    // And issuing into the nested registry leaves the parent untouched.
    nested.register({
      sentinel: sentinel(0, "f".repeat(32)),
      reference: REF,
      encoding: "raw",
      dataOrigin: false,
      location: "nested",
    });
    assertEquals([...registry.all()].length, 1);
    assertEquals(registry.drewPrefixOf(sentinel(0, "f".repeat(32))), false);
  }
});
