// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  SWAMP_DATA_DIR,
  SWAMP_MARKER_FILE,
  SWAMP_SUBDIRS,
  swampMarkerPath,
  swampPath,
  toAbsolutePath,
  toRelativePath,
} from "./paths.ts";

Deno.test("SWAMP_DATA_DIR is .swamp", () => {
  assertEquals(SWAMP_DATA_DIR, ".swamp");
});

Deno.test("SWAMP_MARKER_FILE is .swamp.yaml", () => {
  assertEquals(SWAMP_MARKER_FILE, ".swamp.yaml");
});

Deno.test("swampPath joins segments correctly", () => {
  assertEquals(
    swampPath("/repo", "definitions", "aws/ec2", "my-vpc.yaml"),
    "/repo/.swamp/definitions/aws/ec2/my-vpc.yaml",
  );
});

Deno.test("swampPath with no segments returns data dir", () => {
  assertEquals(swampPath("/repo"), "/repo/.swamp");
});

Deno.test("swampPath with single segment", () => {
  assertEquals(swampPath("/repo", "workflows"), "/repo/.swamp/workflows");
});

Deno.test("swampMarkerPath returns marker file path", () => {
  assertEquals(swampMarkerPath("/repo"), "/repo/.swamp.yaml");
});

Deno.test("SWAMP_SUBDIRS has all expected directories", () => {
  assertEquals(SWAMP_SUBDIRS.definitions, "definitions");
  assertEquals(SWAMP_SUBDIRS.definitionsEvaluated, "definitions-evaluated");
  assertEquals(SWAMP_SUBDIRS.workflows, "workflows");
  assertEquals(SWAMP_SUBDIRS.workflowsEvaluated, "workflows-evaluated");
  assertEquals(SWAMP_SUBDIRS.workflowRuns, "workflow-runs");
  assertEquals(SWAMP_SUBDIRS.outputs, "outputs");
  assertEquals(SWAMP_SUBDIRS.data, "data");
  assertEquals(SWAMP_SUBDIRS.vault, "vault");
  assertEquals(SWAMP_SUBDIRS.secrets, "secrets");
  assertEquals(SWAMP_SUBDIRS.telemetry, "telemetry");
  assertEquals(SWAMP_SUBDIRS.logs, "logs");
  assertEquals(SWAMP_SUBDIRS.files, "files");
  assertEquals(SWAMP_SUBDIRS.inputs, "inputs");
  assertEquals(SWAMP_SUBDIRS.inputsEvaluated, "inputs-evaluated");
  assertEquals(SWAMP_SUBDIRS.resources, "resources");
});

Deno.test("swampPath with SWAMP_SUBDIRS constants", () => {
  assertEquals(
    swampPath("/repo", SWAMP_SUBDIRS.definitions),
    "/repo/.swamp/definitions",
  );
  assertEquals(
    swampPath("/repo", SWAMP_SUBDIRS.workflowRuns, "workflow-123"),
    "/repo/.swamp/workflow-runs/workflow-123",
  );
});

Deno.test("toRelativePath - converts absolute path inside repo to relative", () => {
  const repoDir = "/Users/john/repo";
  const absolutePath = "/Users/john/repo/.swamp/outputs/aws/cli/run.log";

  const result = toRelativePath(repoDir, absolutePath);

  assertEquals(result, ".swamp/outputs/aws/cli/run.log");
});

Deno.test("toRelativePath - returns already relative path unchanged", () => {
  const repoDir = "/Users/john/repo";
  const relativePath = ".swamp/outputs/aws/cli/run.log";

  const result = toRelativePath(repoDir, relativePath);

  assertEquals(result, ".swamp/outputs/aws/cli/run.log");
});

Deno.test("toRelativePath - handles path at repo root", () => {
  const repoDir = "/Users/john/repo";
  const absolutePath = "/Users/john/repo/file.txt";

  const result = toRelativePath(repoDir, absolutePath);

  assertEquals(result, "file.txt");
});

Deno.test("toAbsolutePath - converts relative path to absolute", () => {
  const repoDir = "/Users/john/repo";
  const relativePath = ".swamp/outputs/aws/cli/run.log";

  const result = toAbsolutePath(repoDir, relativePath);

  assertEquals(result, "/Users/john/repo/.swamp/outputs/aws/cli/run.log");
});

Deno.test("toAbsolutePath - returns already absolute path unchanged (backwards compat)", () => {
  const repoDir = "/Users/john/repo";
  const absolutePath = "/Users/john/repo/.swamp/outputs/aws/cli/run.log";

  const result = toAbsolutePath(repoDir, absolutePath);

  assertEquals(result, "/Users/john/repo/.swamp/outputs/aws/cli/run.log");
});

Deno.test("toAbsolutePath - handles different repo directory", () => {
  const repoDir = "/home/alice/projects/infra";
  const relativePath = ".swamp/workflow-runs/my-workflow/run.yaml";

  const result = toAbsolutePath(repoDir, relativePath);

  assertEquals(
    result,
    "/home/alice/projects/infra/.swamp/workflow-runs/my-workflow/run.yaml",
  );
});

Deno.test("toRelativePath and toAbsolutePath - round trip", () => {
  const repoDir = "/Users/john/repo";
  const originalAbsolute = "/Users/john/repo/.swamp/outputs/test.log";

  const relative = toRelativePath(repoDir, originalAbsolute);
  const backToAbsolute = toAbsolutePath(repoDir, relative);

  assertEquals(backToAbsolute, originalAbsolute);
});
