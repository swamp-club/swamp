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
import { SecretBagRegistry } from "./secret_bag_registry.ts";
import { secretOccurrencesOf } from "./secret_occurrences.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";

const REF = { vaultName: "v", key: "k" };
const OTHER = { vaultName: "w", key: "j" };

Deno.test("secretOccurrencesOf.occurrencesIn: finds every sentinel the run issued with its position, reference, origin and location, and no value", () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const vault = bag.addSecret(REF, "methods.run.arguments.a");
  const data = bag.addDataReference(OTHER, "db/main.password");
  const legacy = bag.addDataSecret("legacy-value", REF);
  const view = secretOccurrencesOf(registry);
  const text = `x=${vault};y=${data};z=${legacy}`;
  const found = view.occurrencesIn(text);
  assertEquals(found.map((o) => o.sentinel), [vault, data, legacy]);
  assertEquals(found[0], {
    sentinel: vault,
    start: 2,
    end: 2 + vault.length,
    reference: REF,
    dataOrigin: false,
    location: "methods.run.arguments.a",
  });
  assertEquals(found[1].dataOrigin, true);
  assertEquals(found[1].reference, OTHER);
  assertEquals(found[1].location, "db/main.password");
  assertEquals(text.slice(found[1].start, found[1].end), data);
  // A legacy data entry holds a value; the view never shows it.
  assertEquals(found[2].dataOrigin, true);
  assertEquals(found[2].reference, REF);
  assertEquals(found[2].location, undefined);
  for (const occurrence of found) assertEquals("value" in occurrence, false);
});

Deno.test("secretOccurrencesOf.occurrencesIn: sentinel-shaped text the run did not issue is ordinary text", () => {
  const registry = new SecretBagRegistry();
  const own = new VaultSecretBag(registry).addSecret(REF, "loc");
  const other = `__SWAMP_VSEC_${"ab".repeat(16)}_0__`;
  const view = secretOccurrencesOf(registry);
  assertEquals(
    view.occurrencesIn(`${other} ${own}`).map((o) => o.sentinel),
    [own],
  );
  assertEquals(view.occurrencesIn("no sentinel here"), []);
  assertEquals(view.occurrencesIn(""), []);
  assertEquals(view.originOf(other), undefined);
});

Deno.test("secretOccurrencesOf.originOf: answers the origin and the issue sequence of a sentinel", () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const first = bag.addDataSecret("value-one", REF);
  const second = bag.addSecret(REF, "loc");
  const third = bag.addDataReference(OTHER, "db/main.password");
  const view = secretOccurrencesOf(registry);
  assertEquals(view.originOf(first), { dataOrigin: true, sequence: 0 });
  assertEquals(view.originOf(second), { dataOrigin: false, sequence: 1 });
  assertEquals(view.originOf(third), { dataOrigin: true, sequence: 2 });
});

Deno.test("secretOccurrencesOf: an entry a worker rebuilt has an origin and no reference", () => {
  const sentinel = `__SWAMP_VSEC_${"0".repeat(32)}_0__`;
  const bag = VaultSecretBag.fromEntries([
    { sentinel, value: "shipped", dataOrigin: true },
  ]);
  const view = secretOccurrencesOf(bag.registry);
  const [found] = view.occurrencesIn(`run ${sentinel}`);
  assertEquals(found.reference, undefined);
  assertEquals(found.location, undefined);
  assertEquals(found.dataOrigin, true);
  assertEquals("value" in found, false);
  assertEquals(view.originOf(sentinel), { dataOrigin: true, sequence: 0 });
});
