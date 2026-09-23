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
import {
  type DefinitionStaleness,
  isBehind,
  resolveStaleness,
} from "./definition_staleness.ts";

const V1 = "2026.01.01.1";
const V2 = "2026.06.01.1";
const V3 = "2026.09.01.1";

Deno.test("resolveStaleness: reports current when the definition matches the model version", () => {
  const result = resolveStaleness(V2, V2, [V2]);
  assertEquals(result.state, "current");
  assertEquals(result.definitionVersion, V2);
  assertEquals(result.modelVersion, V2);
});

Deno.test("resolveStaleness: reports current when the definition is ahead of the model", () => {
  assertEquals(resolveStaleness(V3, V2).state, "current");
});

Deno.test("resolveStaleness: reports upgradable when the chain covers the gap", () => {
  assertEquals(resolveStaleness(V1, V2, [V2]).state, "upgradable");
});

Deno.test("resolveStaleness: reports upgradable when only part of the chain applies", () => {
  // Definition at V2, chain declares V2 and V3 — only V3 is newer than V2.
  assertEquals(resolveStaleness(V2, V3, [V2, V3]).state, "upgradable");
});

Deno.test("resolveStaleness: reports stranded when the model bumped with no upgrade chain", () => {
  // The swamp-club#900 case: version moved, no VersionUpgrade shipped.
  assertEquals(resolveStaleness(V1, V2, []).state, "stranded");
});

Deno.test("resolveStaleness: reports stranded when no chain entry is newer than the definition", () => {
  // The chain exists but every entry predates what the definition records, so
  // DefinitionUpgradeService would select nothing.
  assertEquals(resolveStaleness(V2, V3, [V1, V2]).state, "stranded");
});

Deno.test("resolveStaleness: reports unknown when the definition records no version", () => {
  const result = resolveStaleness(undefined, V2, [V2]);
  assertEquals(result.state, "unknown");
  assertEquals(result.definitionVersion, undefined);
});

Deno.test("isBehind: treats upgradable and stranded as behind", () => {
  assertEquals(isBehind(resolveStaleness(V1, V2, [V2])), true);
  assertEquals(isBehind(resolveStaleness(V1, V2, [])), true);
});

Deno.test("isBehind: does not treat current, unknown or invalid as behind", () => {
  assertEquals(isBehind(resolveStaleness(V2, V2)), false);
  // An unstamped definition is not evidence that its arguments are out of
  // date — treating it as behind would fire on every run.
  assertEquals(isBehind(resolveStaleness(undefined, V2)), false);
  // Neither is a malformed one: nothing is known about the arguments, and the
  // signal for it is the failed run, not a staleness report.
  assertEquals(isBehind(resolveStaleness("1.0", V2)), false);
});

Deno.test("resolveStaleness: carries both versions through on every state", () => {
  const cases: DefinitionStaleness[] = [
    resolveStaleness(V2, V2),
    resolveStaleness(V1, V2, [V2]),
    resolveStaleness(V1, V2, []),
  ];
  for (const result of cases) {
    assertEquals(result.modelVersion, V2);
    assertEquals(
      result.definitionVersion,
      result.state === "current" ? V2 : V1,
    );
  }
});

Deno.test("resolveStaleness: treats an unparseable version as invalid rather than throwing", () => {
  // Reachable by hand-editing a definition under models/. `model get` must
  // still describe the definition instead of failing on it, and it must say
  // the version is malformed rather than conflating it with an unstamped
  // definition (swamp-club#2412).
  for (const bad of ["1.0.0", "", "not-a-version", "2026.13", "1"]) {
    const result = resolveStaleness(bad, V2, [V2]);
    assertEquals(result.state, "invalid");
    assertEquals(result.definitionVersion, bad);
    assertEquals(isBehind(result), false);
  }
});
