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
  type ArchiveEntry,
  archiveEntryRefusal,
  planArchiveRootSources,
} from "./archive_root_sources.ts";
import {
  isReservedArchiveRootName,
  SHARED_ARCHIVE_DIR,
} from "./source_archive_plan.ts";

const segment = fc.constantFrom(
  "models",
  "Models",
  "bundles",
  "files",
  "drivers",
  "_shared",
  "_up",
  "lib",
  "_lib",
  "x.ts",
  "data.json",
  ".hidden",
  ".env",
  "deno.json",
  "Package.json",
  "node_modules",
  "..",
);

const entry: fc.Arbitrary<ArchiveEntry> = fc.record({
  path: fc.array(segment, { minLength: 1, maxLength: 4 }).map((segs) =>
    ["extension", ...segs].join("/")
  ),
  kind: fc.constantFrom("file", "directory", "link"),
});

const entries = fc.uniqueArray(entry, {
  maxLength: 12,
  selector: (e) => `${e.kind}:${e.path}`,
});

Deno.test("planArchiveRootSources: the plan does not depend on entry order", () => {
  fc.assert(
    fc.property(entries, fc.integer(), (list, seed) => {
      const shuffled = [...list].sort((a, b) =>
        ((a.path.length * 31 + seed) % 7) - ((b.path.length * 31 + seed) % 7)
      );
      const a = planArchiveRootSources(list);
      const b = planArchiveRootSources(shuffled);
      assertEquals(a.sources, b.sources);
      assertEquals(
        new Set(a.refusals.map((r) => r.path)),
        new Set(b.refusals.map((r) => r.path)),
      );
    }),
  );
});

Deno.test("planArchiveRootSources: an installed source never takes a reserved, hidden or resolution-config path", () => {
  fc.assert(
    fc.property(entries, (list) => {
      for (const source of planArchiveRootSources(list).sources) {
        const segs = source.split("/");
        assert(
          segs[0] === SHARED_ARCHIVE_DIR || !isReservedArchiveRootName(segs[0]),
          source,
        );
        assert(
          !isReservedArchiveRootName(segs[0].toLowerCase()) ||
            segs[0] === SHARED_ARCHIVE_DIR,
          source,
        );
        for (const s of segs) {
          assert(!s.startsWith("."), source);
          assert(
            !["deno.json", "deno.jsonc", "package.json", "node_modules"]
              .includes(s.toLowerCase()),
            source,
          );
        }
      }
    }),
  );
});

Deno.test("planArchiveRootSources: refuses exactly the entries archiveEntryRefusal refuses, links always", () => {
  fc.assert(
    fc.property(entries, (list) => {
      const plan = planArchiveRootSources(list);
      const expected = list.flatMap((e) => {
        const refusal = archiveEntryRefusal(e);
        if (e.kind === "link") assert(refusal !== undefined, e.path);
        return refusal ? [refusal] : [];
      });
      assertEquals(plan.refusals, expected);
    }),
  );
});

Deno.test("planArchiveRootSources: installs exactly the accepted files under shared source roots", () => {
  fc.assert(
    fc.property(entries, (list) => {
      const expected = new Set<string>();
      for (const e of list) {
        if (e.kind !== "file" || archiveEntryRefusal(e)) continue;
        const segs = e.path.split("/").slice(1);
        if (
          segs[0] === SHARED_ARCHIVE_DIR || !isReservedArchiveRootName(segs[0])
        ) {
          expected.add(segs.join("/"));
        }
      }
      assertEquals(planArchiveRootSources(list).sources, [...expected].sort());
    }),
  );
});
