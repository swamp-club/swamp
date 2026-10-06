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
import fc from "fast-check";
import { entryIdentityKey, parseGrantFile } from "./grant_file.ts";

const arbName = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_@.".split("")),
  { minLength: 1, maxLength: 12 },
);

const arbSubjects = fc.uniqueArray(
  fc.tuple(fc.constantFrom("user", "group", "idp-group"), arbName)
    .map(([kind, name]) => `${kind}:${name}`),
  { minLength: 1, maxLength: 8 },
);

const arbResources = fc.uniqueArray(
  fc.tuple(fc.constantFrom("workflow", "model", "data"), arbName)
    .map(([kind, pattern]) => `${kind}:${pattern}`),
  { minLength: 1, maxLength: 8 },
);

const quote = (value: string) => JSON.stringify(value);

Deno.test("parseGrantFile: a subjects/resources entry parses to the same grants as its expanded entries", () => {
  fc.assert(
    fc.property(arbSubjects, arbResources, (subjects, resources) => {
      const combined = parseGrantFile(
        "team.yaml",
        `
grants:
  - subjects: [${subjects.map(quote).join(", ")}]
    effect: allow
    actions: [run, read]
    resources: [${resources.map(quote).join(", ")}]
`,
      );

      const expandedEntries: string[] = [];
      for (const resource of resources) {
        for (const subject of subjects) {
          expandedEntries.push(`
  - subject: ${quote(subject)}
    effect: allow
    actions: [run, read]
    resource: ${quote(resource)}`);
        }
      }
      const expanded = parseGrantFile(
        "team.yaml",
        `grants:${expandedEntries.join("")}\n`,
      );

      assertEquals(combined.errors, []);
      assertEquals(expanded.errors, []);
      assertEquals(combined.entries, expanded.entries);
      assertEquals(
        new Set(combined.entries.map(entryIdentityKey)).size,
        subjects.length * resources.length,
      );
    }),
  );
});
