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
import { join, normalize, SEPARATOR } from "@std/path";
import fc from "fast-check";
import {
  type WorkspaceEntry,
  WorkspaceRegistry,
} from "../../domain/workspace/workspace_registry.ts";
import { hostedWorkspaceFolders } from "./hosted_roster.ts";

const WORKSPACES_DIR = join(SEPARATOR, "host", "workspaces");
const NAMES = ["alpha", "beta", "gamma", "delta"] as const;

type Spelling = "exact" | "dotted" | "trailing" | "outside" | "other_name";

const arbSpelling = fc.constantFrom<Spelling>(
  "exact",
  "dotted",
  "trailing",
  "outside",
  "other_name",
);

// each name is scanned or not, and has no entry or one of these spellings
const arbCase = fc.record({
  scanned: fc.subarray([...NAMES]),
  entries: fc.dictionary(fc.constantFrom(...NAMES), arbSpelling),
});

function entryOf(name: string, spelling: Spelling): WorkspaceEntry {
  const own = join(WORKSPACES_DIR, name);
  const path = spelling === "exact"
    ? own
    : spelling === "dotted"
    ? [WORKSPACES_DIR, "..", "workspaces", name].join(SEPARATOR)
    : spelling === "trailing"
    ? own + SEPARATOR
    : spelling === "outside"
    ? join(SEPARATOR, "projects", name)
    : own;
  return {
    name: spelling === "other_name" ? `${name}-renamed` : name,
    path,
    createdAt: "2026-10-14T10:00:00.000Z",
  };
}

// a lexical resolver stands in for the filesystem's
const realPath = (path: string) => {
  const normal = normalize(path);
  return Promise.resolve(
    normal.length > 1 && normal.endsWith(SEPARATOR)
      ? normal.slice(0, -1)
      : normal,
  );
};

Deno.test("hostedWorkspaceFolders: the workspaces are always the scanned names, each at its own folder", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ scanned, entries }) => {
      const list = Object.entries(entries).map(([name, spelling]) =>
        entryOf(name, spelling)
      );
      const registry = WorkspaceRegistry.fromEntries(list);
      const folders = await hostedWorkspaceFolders({
        workspacesDir: WORKSPACES_DIR,
        scanned,
        registry,
        realPath,
      });
      assertEquals(folders.map((f) => f.name), [...scanned].sort());
      for (const { name, folder } of folders) {
        assertEquals(await realPath(folder), join(WORKSPACES_DIR, name));
      }
    }),
  );
});
