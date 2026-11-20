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
import { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
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

const ROOT = join(SEPARATOR, "host", "root");

function rosterOf(scanned: string[], entries: Record<string, Spelling>) {
  const list = Object.entries(entries).map(([name, spelling]) =>
    entryOf(name, spelling)
  );
  return hostedWorkspaceFolders({
    workspacesDir: WORKSPACES_DIR,
    scanned,
    registry: WorkspaceRegistry.fromEntries(list),
    rootRepo: ROOT,
    realPath,
    isRepo: () => Promise.resolve(true),
  });
}

Deno.test("hostedWorkspaceFolders: one name and one folder per workspace, never the root, sorted", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ scanned, entries }) => {
      const { workspaces } = await rosterOf(scanned, entries);
      const names = workspaces.map((w) => w.name);
      assertEquals(names, [...new Set(names)].sort());
      const folders = await Promise.all(
        workspaces.map((w) => realPath(w.folder)),
      );
      assertEquals(folders.length, new Set(folders).size);
      assertEquals(folders.includes(ROOT), false);
    }),
  );
});

Deno.test("hostedWorkspaceFolders: the host's own is exactly a workspace at workspaces/<its name>, and only once scanned", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ scanned, entries }) => {
      const { workspaces } = await rosterOf(scanned, entries);
      for (const { name, folder, owner } of workspaces) {
        const own = (await realPath(folder)) === join(WORKSPACES_DIR, name);
        assertEquals(owner === "host", own);
        if (owner === "host") {
          assertEquals((scanned as string[]).includes(name), true);
        }
      }
    }),
  );
});

Deno.test("hostedWorkspaceFolders: every entry outside workspaces/ is listed, and a scanned folder is passed over only when an entry has its name or folder", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ scanned, entries }) => {
      const { workspaces } = await rosterOf(scanned, entries);
      const byName = new Map(workspaces.map((w) => [w.name, w]));
      for (const [name, spelling] of Object.entries(entries)) {
        if (spelling !== "outside") continue;
        assertEquals(byName.get(name)?.owner, "operator");
      }
      const listedFolders = new Set(
        await Promise.all(workspaces.map((w) => realPath(w.folder))),
      );
      for (const name of scanned) {
        if (byName.has(name)) continue;
        assertEquals(listedFolders.has(join(WORKSPACES_DIR, name)), true);
      }
    }),
  );
});

// with no registry read, wanted files naming scanned folders, the root, or each other's folder
const arbFallback = fc.record({
  scanned: fc.subarray([...NAMES]),
  wanted: fc.dictionary(
    fc.constantFrom("w1", "w2", "w3", ...NAMES),
    fc.record({
      active: fc.boolean(),
      target: fc.constantFrom<"scanned" | "root" | "shared" | "own">(
        "scanned",
        "root",
        "shared",
        "own",
      ),
      of: fc.constantFrom(...NAMES),
    }),
  ),
});

Deno.test("hostedWorkspaceFolders: with no registry read, one folder per workspace still, and never the root", async () => {
  await fc.assert(
    fc.asyncProperty(arbFallback, async ({ scanned, wanted }) => {
      const records = new Map(
        Object.entries(wanted).map(([name, w]) => {
          const folder = w.target === "scanned"
            ? join(WORKSPACES_DIR, w.of)
            : w.target === "root"
            ? ROOT + SEPARATOR
            : w.target === "shared"
            ? join(SEPARATOR, "projects", "shared")
            : join(SEPARATOR, "projects", name);
          const record = HostedWorkspace.active(name).withFolder(folder);
          return [name, w.active ? record : record.suspend(new Date(0))];
        }),
      );
      const { workspaces } = await hostedWorkspaceFolders({
        workspacesDir: WORKSPACES_DIR,
        scanned,
        registry: null,
        rootRepo: ROOT,
        wanted: records,
        realPath,
        isRepo: () => Promise.resolve(true),
      });
      const folders = await Promise.all(
        workspaces.map((w) => realPath(w.folder)),
      );
      assertEquals(folders.length, new Set(folders).size);
      assertEquals(folders.includes(ROOT), false);
    }),
  );
});

Deno.test("hostedWorkspaceFolders: with no host folder no workspace is the host's own, every entry but the root's is listed once, and none is gone", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ entries }) => {
      const list = Object.entries(entries).map(([name, spelling]) =>
        entryOf(name, spelling)
      );
      const roster = await hostedWorkspaceFolders({
        workspacesDir: WORKSPACES_DIR,
        hostFolder: false,
        scanned: [],
        registry: WorkspaceRegistry.fromEntries(list),
        rootRepo: ROOT,
        realPath,
        isRepo: () => Promise.resolve(true),
      });
      assertEquals(
        roster.workspaces.every((w) => w.owner === "operator"),
        true,
      );
      assertEquals(roster.gone, []);
      const folders = await Promise.all(
        roster.workspaces.map((w) => realPath(w.folder)),
      );
      assertEquals(folders.length, new Set(folders).size);
      const distinct = new Set(
        await Promise.all(list.map((e) => realPath(e.path))),
      );
      assertEquals(roster.workspaces.length, distinct.size);
    }),
  );
});

type WantedShape = "none" | "made" | "no_creator" | "no_folder" | "elsewhere";

Deno.test("hostedWorkspaceFolders: with no host folder an entry is the host's own exactly when its wanted file has a creator and names the entry's folder, whatever its spelling", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.dictionary(
        fc.constantFrom(...NAMES),
        fc.record({
          spelling: fc.constantFrom<Spelling>("exact", "dotted", "trailing"),
          wanted: fc.constantFrom<WantedShape>(
            "none",
            "made",
            "no_creator",
            "no_folder",
            "elsewhere",
          ),
        }),
      ),
      async (cases) => {
        const location = join(SEPARATOR, "data", "workspaces");
        const at = new Date("2026-11-20T10:00:00.000Z");
        const wanted = new Map<string, HostedWorkspace>();
        const entries: WorkspaceEntry[] = [];
        for (
          const [name, { spelling, wanted: shape }] of Object.entries(cases)
        ) {
          const own = join(location, name);
          entries.push({
            name,
            path: spelling === "exact"
              ? own
              : spelling === "dotted"
              ? [location, "..", "workspaces", name].join(SEPARATOR)
              : own + SEPARATOR,
            createdAt: "2026-11-20T10:00:00.000Z",
          });
          const made = HostedWorkspace.create(name, "user:sub-alice", at);
          if (shape === "made") wanted.set(name, made.withFolder(own));
          if (shape === "no_creator") {
            wanted.set(name, HostedWorkspace.active(name).withFolder(own));
          }
          if (shape === "no_folder") wanted.set(name, made);
          if (shape === "elsewhere") {
            wanted.set(
              name,
              made.withFolder(join(SEPARATOR, "elsewhere", name)),
            );
          }
        }
        const roster = await hostedWorkspaceFolders({
          workspacesDir: join(SEPARATOR, "data", "host"),
          hostFolder: false,
          scanned: [],
          registry: WorkspaceRegistry.fromEntries(entries),
          rootRepo: null,
          wanted,
          realPath,
          isRepo: () => Promise.resolve(true),
        });
        for (const workspace of roster.workspaces) {
          assertEquals(
            workspace.owner === "host",
            cases[workspace.name].wanted === "made",
            workspace.name,
          );
        }
        assertEquals(roster.workspaces.length, Object.keys(cases).length);
      },
    ),
  );
});
