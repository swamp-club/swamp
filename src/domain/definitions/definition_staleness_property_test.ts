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
import fc from "fast-check";
import { CalVer } from "../models/calver.ts";
import { isBehind, resolveStaleness } from "./definition_staleness.ts";

/** A CalVer string built from ordered parts so generated versions compare. */
const arbCalVer = fc.record({
  y: fc.integer({ min: 2020, max: 2030 }),
  m: fc.integer({ min: 1, max: 12 }),
  d: fc.integer({ min: 1, max: 28 }),
  micro: fc.integer({ min: 1, max: 9 }),
}).map(({ y, m, d, micro }) =>
  `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}.${micro}`
);

Deno.test("resolveStaleness property: state agrees with CalVer ordering", () => {
  fc.assert(
    fc.property(
      arbCalVer,
      arbCalVer,
      fc.array(arbCalVer, { maxLength: 5 }),
      (defVersion, modelVersion, chain) => {
        const result = resolveStaleness(defVersion, modelVersion, chain);
        const behind = CalVer.compare(
          CalVer.create(defVersion),
          CalVer.create(modelVersion),
        ) <
          0;
        // "current" must mean exactly "not behind by CalVer ordering".
        assertEquals(result.state === "current", !behind);
        // Every behind case resolves to one of the two behind states.
        assertEquals(isBehind(result), behind);
      },
    ),
  );
});

Deno.test("resolveStaleness property: upgradable requires a chain entry newer than the definition", () => {
  fc.assert(
    fc.property(
      arbCalVer,
      arbCalVer,
      fc.array(arbCalVer, { maxLength: 5 }),
      (defVersion, modelVersion, chain) => {
        const result = resolveStaleness(defVersion, modelVersion, chain);
        if (result.state !== "upgradable") return;
        // Mirrors the predicate DefinitionUpgradeService uses to select
        // applicable upgrades — the two must never disagree.
        assert(
          chain.some((c) =>
            CalVer.compare(CalVer.create(c), CalVer.create(defVersion)) > 0
          ),
        );
      },
    ),
  );
});

Deno.test("resolveStaleness property: an absent version is always unknown and never behind", () => {
  fc.assert(
    fc.property(
      arbCalVer,
      fc.array(arbCalVer, { maxLength: 5 }),
      (modelVersion, chain) => {
        const result = resolveStaleness(undefined, modelVersion, chain);
        assertEquals(result.state, "unknown");
        assertEquals(isBehind(result), false);
      },
    ),
  );
});

Deno.test("resolveStaleness property: equal by value for equal inputs", () => {
  fc.assert(
    fc.property(
      fc.option(arbCalVer, { nil: undefined }),
      arbCalVer,
      fc.array(arbCalVer, { maxLength: 5 }),
      (defVersion, modelVersion, chain) => {
        assertEquals(
          resolveStaleness(defVersion, modelVersion, chain),
          resolveStaleness(defVersion, modelVersion, chain),
        );
      },
    ),
  );
});

Deno.test("resolveStaleness property: the result always carries its inputs back", () => {
  fc.assert(
    fc.property(
      fc.option(arbCalVer, { nil: undefined }),
      arbCalVer,
      (defVersion, modelVersion) => {
        const result = resolveStaleness(defVersion, modelVersion);
        assertEquals(result.definitionVersion, defVersion);
        assertEquals(result.modelVersion, modelVersion);
      },
    ),
  );
});
