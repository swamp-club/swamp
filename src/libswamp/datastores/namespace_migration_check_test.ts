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
  type DetectUnmigratedDeps,
  detectUnmigratedNamespaceData,
  formatUnmigratedWarning,
} from "./namespace_migration_check.ts";

const DS_PATH = "/tmp/ds";

function makeDeps(
  overrides: Partial<DetectUnmigratedDeps> = {},
): DetectUnmigratedDeps {
  return {
    dirExists: () => Promise.resolve(false),
    dirHasDataFiles: () => Promise.resolve(false),
    ...overrides,
  };
}

Deno.test("detectUnmigratedNamespaceData: returns empty when no namespace", async () => {
  const result = await detectUnmigratedNamespaceData(
    DS_PATH,
    undefined,
    makeDeps(),
  );
  assertEquals(result, []);
});

Deno.test("detectUnmigratedNamespaceData: returns empty when no source dirs exist", async () => {
  const result = await detectUnmigratedNamespaceData(
    DS_PATH,
    "infra",
    makeDeps({ dirExists: () => Promise.resolve(false) }),
  );
  assertEquals(result, []);
});

Deno.test("detectUnmigratedNamespaceData: returns empty when source has no data files", async () => {
  const result = await detectUnmigratedNamespaceData(
    DS_PATH,
    "infra",
    makeDeps({
      dirExists: () => Promise.resolve(true),
      dirHasDataFiles: () => Promise.resolve(false),
    }),
  );
  assertEquals(result, []);
});

Deno.test("detectUnmigratedNamespaceData: detects un-migrated dirs", async () => {
  const existingDirs = new Set([
    "/tmp/ds/workflow-runs",
    "/tmp/ds/data",
    "/tmp/ds/outputs",
  ]);
  const dirsWithData = new Set([
    "/tmp/ds/workflow-runs",
    "/tmp/ds/data",
  ]);

  const result = await detectUnmigratedNamespaceData(
    DS_PATH,
    "infra",
    makeDeps({
      dirExists: (p) => Promise.resolve(existingDirs.has(p)),
      dirHasDataFiles: (p) => Promise.resolve(dirsWithData.has(p)),
    }),
  );

  assertEquals(result.length, 2);
  const subdirs = result.map((r) => r.subdir);
  assertEquals(subdirs.includes("workflow-runs"), true);
  assertEquals(subdirs.includes("data"), true);
});

Deno.test("detectUnmigratedNamespaceData: skips dirs already migrated", async () => {
  const existingDirs = new Set([
    "/tmp/ds/workflow-runs",
    "/tmp/ds/infra/workflow-runs",
  ]);
  const dirsWithData = new Set([
    "/tmp/ds/workflow-runs",
    "/tmp/ds/infra/workflow-runs",
  ]);

  const result = await detectUnmigratedNamespaceData(
    DS_PATH,
    "infra",
    makeDeps({
      dirExists: (p) => Promise.resolve(existingDirs.has(p)),
      dirHasDataFiles: (p) => Promise.resolve(dirsWithData.has(p)),
    }),
  );

  assertEquals(result, []);
});

Deno.test("formatUnmigratedWarning: singular directory", () => {
  const warning = formatUnmigratedWarning([
    { subdir: "workflow-runs", source: "/a", destination: "/b" },
  ]);
  assertStringIncludes(warning, "1 directory");
  assertStringIncludes(warning, "workflow-runs");
  assertStringIncludes(warning, "namespace migrate --confirm");
});

Deno.test("formatUnmigratedWarning: multiple directories", () => {
  const warning = formatUnmigratedWarning([
    { subdir: "workflow-runs", source: "/a", destination: "/b" },
    { subdir: "data", source: "/c", destination: "/d" },
  ]);
  assertStringIncludes(warning, "2 directories");
  assertStringIncludes(warning, "workflow-runs, data");
});
