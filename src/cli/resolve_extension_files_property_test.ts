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

// Properties of planWorkflowArchiveNames (swamp-club#2613): archive names
// inside one package are pairwise distinct or the planner throws, and the
// legacy names for bare entries and single-entry directories never change.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { basename } from "@std/path";
import { dirname as posixDirname } from "@std/path/posix";
import fc from "fast-check";
import { UserError } from "../domain/errors.ts";
import {
  planWorkflowArchiveNames,
  type WorkflowManifestEntry,
} from "./resolve_extension_files.ts";

const arbDir = fc.constantFrom("a", "b", "workflows", "Sub", "x_y", "a/b");
const arbFile = fc.constantFrom("workflow", "deploy", "a", "b", "A", "x_y");
const arbRef = fc.tuple(
  fc.array(arbDir, { minLength: 0, maxLength: 2 }),
  arbFile,
  fc.constantFrom(".yaml", ".yml"),
).map(([dirs, file, ext]) => [...dirs, `${file}${ext}`].join("/"));

const arbEntries: fc.Arbitrary<WorkflowManifestEntry[]> = fc.array(arbRef, {
  minLength: 1,
  maxLength: 6,
}).map((refs) => refs.map((ref) => ({ ref, realPath: `/repo/${ref}` })));

/** Manifest refs always use forward slashes, so posix dirname applies. */
function rawDirOf(ref: string): string {
  const dir = posixDirname(ref);
  return dir === "." ? "" : dir;
}

function dirOf(ref: string): string {
  return rawDirOf(ref).toLowerCase();
}

Deno.test("planWorkflowArchiveNames: archive names are pairwise distinct or the planner throws", () => {
  fc.assert(
    fc.property(arbEntries, (entries) => {
      let planned;
      try {
        planned = planWorkflowArchiveNames(entries);
      } catch (err) {
        assert(err instanceof UserError);
        return;
      }
      assertEquals(planned.length, entries.length);
      const keys = new Set(planned.map((p) => p.archiveName.toLowerCase()));
      assertEquals(keys.size, planned.length);
    }),
  );
});

Deno.test("planWorkflowArchiveNames: bare and single-entry-directory names match the legacy rule", () => {
  fc.assert(
    fc.property(arbEntries, (entries) => {
      let planned;
      try {
        planned = planWorkflowArchiveNames(entries);
      } catch (err) {
        assert(err instanceof UserError);
        return;
      }
      const perDir = new Map<string, number>();
      for (const e of entries) {
        perDir.set(dirOf(e.ref), (perDir.get(dirOf(e.ref)) ?? 0) + 1);
      }
      for (const [i, entry] of entries.entries()) {
        const dir = dirOf(entry.ref);
        if (dir === "") {
          assertEquals(planned[i].archiveName, basename(entry.realPath));
        } else if (perDir.get(dir) === 1) {
          const rawDir = rawDirOf(entry.ref);
          assertEquals(
            planned[i].archiveName,
            `${rawDir.replace(/\//g, "-")}.yaml`,
          );
          assertEquals(planned[i].lookupName, rawDir.replace(/_/g, "-"));
        } else {
          assertEquals(planned[i].archiveName, basename(entry.realPath));
        }
      }
    }),
  );
});

Deno.test("planWorkflowArchiveNames: the empty manifest plans nothing", () => {
  assertEquals(planWorkflowArchiveNames([]), []);
});

Deno.test("planWorkflowArchiveNames: a bare entry and a directory entry with the same name clash", () => {
  assertThrows(
    () =>
      planWorkflowArchiveNames([
        { ref: "x.yaml", realPath: "/repo/x.yaml" },
        { ref: "x/workflow.yaml", realPath: "/repo/x/workflow.yaml" },
      ]),
    UserError,
  );
});
