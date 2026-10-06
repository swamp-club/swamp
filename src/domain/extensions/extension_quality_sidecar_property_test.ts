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
import { stringify as stringifyYaml } from "@std/yaml";
import fc from "fast-check";
import { MAX_ACCEPTANCE_REASON_LENGTH } from "./extension_acceptances.ts";
import {
  parseQualitySidecar,
  type QualitySidecar,
} from "./extension_quality_sidecar.ts";

const word = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9 ._/:-]{0,60}$/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const sidecarArb: fc.Arbitrary<QualitySidecar> = fc.record({
  version: fc.constant(1 as const),
  generated: fc.option(
    fc.record({ by: word, source: word, commit: word }),
    { nil: undefined },
  ),
  accept: fc.array(
    fc.record({
      rule: fc.constantFrom("bare-specifiers", "ipv4-address-literals"),
      reason: word,
      file: fc.option(
        fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,2}\.txt$/),
        { nil: undefined },
      ),
    }).map((entry) =>
      entry.file === undefined
        ? { rule: entry.rule, reason: entry.reason }
        : entry
    ),
    { maxLength: 10 },
  ),
}).map((s) =>
  s.generated === undefined ? { version: s.version, accept: s.accept } : s
);

Deno.test("sidecar property: stringify then parse round-trips the sidecar", () => {
  fc.assert(
    fc.property(sidecarArb, (sidecar) => {
      const yaml = stringifyYaml(sidecar);
      const result = parseQualitySidecar(yaml);
      assert(result.ok, result.ok ? "" : result.errors.join("; "));
      assertEquals(result.sidecar, sidecar);
    }),
  );
});

Deno.test("sidecar property: a reason over the cap is always refused", () => {
  fc.assert(
    fc.property(
      fc.integer({
        min: MAX_ACCEPTANCE_REASON_LENGTH + 1,
        max: MAX_ACCEPTANCE_REASON_LENGTH * 3,
      }),
      (length) => {
        const result = parseQualitySidecar(
          stringifyYaml({
            version: 1,
            accept: [{ rule: "bare-specifiers", reason: "r".repeat(length) }],
          }),
        );
        assertEquals(result.ok, false);
      },
    ),
  );
});

Deno.test("sidecar property: the parser never throws on arbitrary text", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      parseQualitySidecar(raw);
    }),
  );
});
