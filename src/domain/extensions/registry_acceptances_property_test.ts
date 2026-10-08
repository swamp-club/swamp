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
import {
  MAX_REGISTRY_ACCEPTANCES,
  parseRegistryAcceptances,
} from "./registry_acceptances.ts";

const SOURCES = ["inline", "sidecar", "generated"];

/** Entries that look like the registry's, with some fields wrong. */
const entryArb = fc.record({
  rule: fc.oneof(fc.string(), fc.constant(null), fc.integer()),
  file: fc.oneof(fc.string(), fc.constant(null)),
  line: fc.oneof(fc.integer(), fc.constant(null), fc.double()),
  reason: fc.oneof(fc.string(), fc.constant(null)),
  source: fc.oneof(fc.constantFrom(...SOURCES), fc.string()),
}, { requiredKeys: [] });

const acceptancesArb = fc.oneof(
  fc.jsonValue(),
  fc.record({
    accepted: fc.oneof(fc.array(entryArb), fc.jsonValue()),
    generated: fc.oneof(
      fc.constant(null),
      fc.record({ by: fc.string(), source: fc.string(), commit: fc.string() }),
      fc.jsonValue(),
    ),
    total: fc.oneof(fc.integer(), fc.double(), fc.constant(null)),
  }, { requiredKeys: [] }),
);

Deno.test("parseRegistryAcceptances property: any input yields nothing or well-formed acceptances", () => {
  fc.assert(
    fc.property(acceptancesArb, (raw) => {
      const parsed = parseRegistryAcceptances(raw);
      if (parsed === undefined) return;
      assert(parsed.accepted.length > 0 || parsed.generated !== undefined);
      assert(parsed.accepted.length <= MAX_REGISTRY_ACCEPTANCES);
      assert(
        parsed.total !== undefined &&
          Number.isInteger(parsed.total) &&
          parsed.total >= parsed.accepted.length,
      );
      for (const entry of parsed.accepted) {
        assert(typeof entry.rule === "string" && entry.rule.length > 0);
        assert(SOURCES.includes(entry.source));
        assert(entry.file === undefined || typeof entry.file === "string");
        assert(
          entry.line === undefined ||
            (Number.isInteger(entry.line) && entry.line > 0),
        );
        assert(entry.reason === undefined || typeof entry.reason === "string");
      }
    }),
  );
});

Deno.test("parseRegistryAcceptances property: a well-formed entry is kept with its present fields", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.option(fc.string({ minLength: 1 }), { nil: null }),
      fc.option(fc.integer({ min: 1 }), { nil: null }),
      fc.option(fc.string({ minLength: 1 }), { nil: null }),
      fc.constantFrom(...SOURCES),
      (rule, file, line, reason, source) => {
        const parsed = parseRegistryAcceptances({
          accepted: [{ rule, file, line, reason, source }],
          generated: null,
          total: 1,
        });
        assertEquals(parsed?.accepted, [{
          rule,
          ...(file !== null ? { file } : {}),
          ...(line !== null ? { line } : {}),
          ...(reason !== null ? { reason } : {}),
          source,
        }]);
      },
    ),
  );
});
