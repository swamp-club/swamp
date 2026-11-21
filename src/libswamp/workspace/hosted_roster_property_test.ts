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
import { basename, join, normalize, SEPARATOR } from "@std/path";
import fc from "fast-check";
import {
  type WorkspaceEntry,
  WorkspaceRegistry,
} from "../../domain/workspace/workspace_registry.ts";
import { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import { hostedWorkspaceFolders, type RepoIdentity } from "./hosted_roster.ts";

const LOCATION = join(SEPARATOR, "data", "workspaces");
const NAMES = ["alpha", "beta", "gamma", "delta"] as const;

type Spelling = "exact" | "dotted" | "trailing" | "outside" | "other_name";

const arbSpelling = fc.constantFrom<Spelling>(
  "exact",
  "dotted",
  "trailing",
  "outside",
  "other_name",
);

// each name has no entry or one of these spellings
const arbCase = fc.record({
  entries: fc.dictionary(fc.constantFrom(...NAMES), arbSpelling),
});

function entryOf(name: string, spelling: Spelling): WorkspaceEntry {
  const own = join(LOCATION, name);
  const path = spelling === "exact"
    ? own
    : spelling === "dotted"
    ? [LOCATION, "..", "workspaces", name].join(SEPARATOR)
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

function rosterOf(entries: Record<string, Spelling>) {
  const list = Object.entries(entries).map(([name, spelling]) =>
    entryOf(name, spelling)
  );
  return hostedWorkspaceFolders({
    registry: WorkspaceRegistry.fromEntries(list),
    rootRepo: ROOT,
    realPath,
    isRepo: () => Promise.resolve(true),
  });
}

Deno.test("hostedWorkspaceFolders: one name and one folder per workspace, never the root, sorted", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ entries }) => {
      const { workspaces } = await rosterOf(entries);
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

// with no registry read, wanted files naming folders in the location, the root, or each other's folder
const arbFallback = fc.record({
  wanted: fc.dictionary(
    fc.constantFrom("w1", "w2", "w3", ...NAMES),
    fc.record({
      active: fc.boolean(),
      target: fc.constantFrom<"location" | "root" | "shared" | "own">(
        "location",
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
    fc.asyncProperty(arbFallback, async ({ wanted }) => {
      const records = new Map(
        Object.entries(wanted).map(([name, w]) => {
          const folder = w.target === "location"
            ? join(LOCATION, w.of)
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

Deno.test("hostedWorkspaceFolders: with no wanted file no workspace is the host's own, and every entry but the root's is listed once", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ entries }) => {
      const list = Object.entries(entries).map(([name, spelling]) =>
        entryOf(name, spelling)
      );
      const roster = await hostedWorkspaceFolders({
        registry: WorkspaceRegistry.fromEntries(list),
        rootRepo: ROOT,
        realPath,
        isRepo: () => Promise.resolve(true),
      });
      assertEquals(
        roster.workspaces.every((w) => w.owner === "operator"),
        true,
      );
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

type WantedShape =
  | "none"
  | "made"
  | "no_creator"
  | "no_folder"
  | "elsewhere"
  | "no_repo_id"
  | "replaced";
type FolderState = "repo" | "absent" | "unreadable";

Deno.test("hostedWorkspaceFolders: an entry is the host's own exactly when its wanted file has a creator, names the entry's folder, whatever its spelling, and records the repo in it or a folder not there yet", async () => {
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
            "no_repo_id",
            "replaced",
          ),
          folder: fc.constantFrom<FolderState>("repo", "absent", "unreadable"),
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
          const made = HostedWorkspace.create(name, "user:sub-alice", at)
            .withRepoId(`repo-${name}`);
          if (shape === "made") wanted.set(name, made.withFolder(own));
          if (shape === "no_repo_id") {
            wanted.set(name, made.withFolder(own).withRepoId(null));
          }
          if (shape === "replaced") {
            wanted.set(name, made.withFolder(own).withRepoId(`old-${name}`));
          }
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
          registry: WorkspaceRegistry.fromEntries(entries),
          rootRepo: null,
          wanted,
          realPath,
          isRepo: () => Promise.resolve(true),
          repoIdentity: (folder) => {
            const name = basename(normalize(folder));
            const state = cases[name].folder;
            return Promise.resolve<RepoIdentity>(
              state === "repo"
                ? { kind: "id", repoId: `repo-${name}` }
                : { kind: state },
            );
          },
        });
        for (const workspace of roster.workspaces) {
          const { wanted: shape, folder } = cases[workspace.name];
          assertEquals(
            workspace.owner === "host",
            folder === "absent"
              ? shape === "made" || shape === "replaced"
              : shape === "made" && folder === "repo",
            workspace.name,
          );
          assertEquals(
            workspace.replaced === true,
            shape === "replaced" && folder === "repo",
            workspace.name,
          );
        }
        assertEquals(roster.workspaces.length, Object.keys(cases).length);
      },
    ),
  );
});
