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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ArchiveEntry,
  type ArchiveEntryKind,
  archiveEntryRefusal,
  archiveRootSourceDirs,
  planArchiveRootSources,
} from "./archive_root_sources.ts";

const file = (path: string): ArchiveEntry => ({ path, kind: "file" });
const dir = (path: string): ArchiveEntry => ({ path, kind: "directory" });
const link = (path: string): ArchiveEntry => ({ path, kind: "symlink" });

Deno.test("planArchiveRootSources: installs mirrored root files, skipping reserved names", () => {
  const plan = planArchiveRootSources([
    dir("extension/"),
    file("extension/manifest.yaml"),
    file("extension/quality.yaml"),
    file("extension/dependency-audit.json"),
    file("extension/models/x.ts"),
    file("extension/bundles/x.js"),
    file("extension/skills/s/SKILL.md"),
    file("extension/files/README.md"),
    dir("extension/lib/"),
    file("extension/lib/cmp.ts"),
    file("extension/_lib/schemas.ts"),
    file("extension/helpers.ts"),
    file("extension/lib/data/table.json"),
  ]);
  assertEquals(plan.refusals, []);
  assertEquals(plan.sources, [
    "_lib/schemas.ts",
    "helpers.ts",
    "lib/cmp.ts",
    "lib/data/table.json",
  ]);
});

Deno.test("planArchiveRootSources: files under _shared are installed", () => {
  // _shared is reserved so push never mirrors into it, but pull must
  // install what push placed there: rewritten importers point at it.
  const plan = planArchiveRootSources([
    file("extension/_shared/_up/shared/util.ts"),
  ]);
  assertEquals(plan.refusals, []);
  assertEquals(plan.sources, ["_shared/_up/shared/util.ts"]);
});

Deno.test("planArchiveRootSources: legacy driver directories install nothing, empty or not", () => {
  const plan = planArchiveRootSources([
    dir("extension/drivers/"),
    dir("extension/driver-bundles/"),
    file("extension/drivers/aer.ts"),
    file("extension/driver-bundles/mod.js"),
  ]);
  assertEquals(plan, { sources: [], refusals: [] });
});

Deno.test("planArchiveRootSources: an empty non-reserved directory installs nothing", () => {
  assertEquals(planArchiveRootSources([dir("extension/lib/")]), {
    sources: [],
    refusals: [],
  });
});

Deno.test("planArchiveRootSources: entries outside extension/ are ignored", () => {
  assertEquals(
    planArchiveRootSources([file("README.md"), file("other/lib/x.ts")]),
    { sources: [], refusals: [] },
  );
});

Deno.test("planArchiveRootSources: a leading ./ is ignored", () => {
  assertEquals(planArchiveRootSources([file("./extension/lib/x.ts")]).sources, [
    "lib/x.ts",
  ]);
});

Deno.test("archiveEntryRefusal: anything but a file or directory refuses the archive wherever it is", () => {
  const reasons: [ArchiveEntryKind, string][] = [
    ["symlink", "is a symlink; extensions may not contain links"],
    ["hardlink", "is a hardlink; extensions may not contain links"],
    [
      "character-device",
      "is a character device; an extension holds only regular files and directories",
    ],
    [
      "block-device",
      "is a block device; an extension holds only regular files and directories",
    ],
    [
      "fifo",
      "is a FIFO; an extension holds only regular files and directories",
    ],
    [
      "unsupported",
      "has an unsupported tar entry type; an extension holds only regular files and directories",
    ],
  ];
  for (const [kind, reason] of reasons) {
    for (
      const path of [
        "extension/models/x.ts",
        "extension/lib/x.ts",
        "extension/files/data",
        "elsewhere",
      ]
    ) {
      assertEquals(archiveEntryRefusal({ path, kind }), { path, reason });
    }
  }
});

Deno.test("archiveEntryRefusal: files and directories outside shared sources are accepted", () => {
  for (const kind of ["file", "directory"] as const) {
    assertEquals(
      archiveEntryRefusal({ path: "extension/models/x.ts", kind }),
      undefined,
    );
  }
});

Deno.test("archiveEntryRefusal: hidden segments under a shared source are refused", () => {
  for (
    const path of [
      "extension/.env",
      "extension/lib/.secret.ts",
      "extension/lib/.git/config",
      "extension/_shared/_up/.env",
    ]
  ) {
    assertStringIncludes(
      archiveEntryRefusal(file(path))!.reason,
      "hidden",
      path,
    );
  }
});

Deno.test("archiveEntryRefusal: resolution config files and node_modules under a shared source are refused", () => {
  for (
    const [path, name] of [
      ["extension/deno.json", "deno.json"],
      ["extension/lib/deno.jsonc", "deno.jsonc"],
      ["extension/lib/package.json", "package.json"],
      ["extension/lib/node_modules/x/index.ts", "node_modules"],
      ["extension/node_modules/", "node_modules"],
      ["extension/lib/Deno.json", "Deno.json"],
    ]
  ) {
    const kind = path.endsWith("/") ? dir(path) : file(path);
    assertStringIncludes(archiveEntryRefusal(kind)!.reason, `is ${name}`, path);
  }
});

Deno.test("archiveEntryRefusal: a backslash under a shared source is refused, whatever it hides", () => {
  for (
    const path of [
      "extension/lib\\deno.json",
      "extension/lib\\x.ts",
      "extension\\lib\\x.ts",
      "extension/a\\..\\..\\journal",
      "extension/Models\\x.ts",
      "extension/_shared/_up\\x.ts",
    ]
  ) {
    const refusal = archiveEntryRefusal(file(path));
    assertEquals(refusal?.path, path);
    assertStringIncludes(refusal!.reason, "backslash", path);
  }
});

Deno.test("archiveEntryRefusal: a backslash inside a reserved directory keeps pull's earlier rules", () => {
  assertEquals(archiveEntryRefusal(file("extension/models\\x.ts")), undefined);
});

Deno.test("planArchiveRootSources: a backslash path is never installed", () => {
  const plan = planArchiveRootSources([
    file("extension/lib\\deno.json"),
    file("extension/lib/ok.ts"),
  ]);
  assertEquals(plan.sources, ["lib/ok.ts"]);
  assertEquals(plan.refusals.map((r) => r.path), ["extension/lib\\deno.json"]);
});

Deno.test("archiveEntryRefusal: a case variant of a reserved name is refused", () => {
  const refusal = archiveEntryRefusal(file("extension/Models/x.ts"));
  assertStringIncludes(refusal!.reason, "reserved archive directory models");
});

Deno.test("archiveEntryRefusal: reserved directories keep pull's earlier rules", () => {
  for (
    const path of [
      "extension/models/.hidden.ts",
      "extension/files/package.json",
      "extension/skills/s/deno.json",
    ]
  ) {
    assertEquals(archiveEntryRefusal(file(path)), undefined, path);
  }
});

Deno.test("planArchiveRootSources: lists every refusal and installs nothing it refuses", () => {
  const plan = planArchiveRootSources([
    file("extension/lib/ok.ts"),
    link("extension/lib/link.ts"),
    file("extension/lib/.hidden.ts"),
  ]);
  assertEquals(plan.sources, ["lib/ok.ts"]);
  assertEquals(plan.refusals.map((r) => r.path), [
    "extension/lib/link.ts",
    "extension/lib/.hidden.ts",
  ]);
});

Deno.test("archiveRootSourceDirs: the first segment of every source inside a directory", () => {
  assertEquals(
    archiveRootSourceDirs([
      "helpers.ts",
      "lib/cmp.ts",
      "lib/data/x.json",
      "_shared/_up/s.ts",
    ]),
    ["_shared", "lib"],
  );
});
