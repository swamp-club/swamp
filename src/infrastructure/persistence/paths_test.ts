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

import { assertEquals, assertThrows } from "@std/assert";
import {
  bundleNamespace,
  getSwampConfigDir,
  getSwampDataDir,
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

Deno.test("getSwampConfigDir uses XDG_CONFIG_HOME when set", () => {
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", "/custom/config");
    assertEquals(getSwampConfigDir(), "/custom/config/swamp");
  } finally {
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
  }
});

Deno.test("getSwampConfigDir falls back to HOME/.config/swamp", () => {
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.delete("XDG_CONFIG_HOME");
    Deno.env.set("HOME", "/home/testuser");
    assertEquals(getSwampConfigDir(), "/home/testuser/.config/swamp");
  } finally {
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
  }
});

Deno.test("getSwampConfigDir throws when HOME is not set", () => {
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.delete("XDG_CONFIG_HOME");
    Deno.env.delete("HOME");
    assertThrows(
      () => getSwampConfigDir(),
      Error,
      "HOME environment variable is not set",
    );
  } finally {
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
  }
});

Deno.test("getSwampDataDir uses HOME", () => {
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", "/home/testuser");
    assertEquals(getSwampDataDir(), "/home/testuser/.swamp");
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
  }
});

Deno.test("getSwampDataDir falls back to USERPROFILE", () => {
  const originalHome = Deno.env.get("HOME");
  const originalProfile = Deno.env.get("USERPROFILE");
  try {
    Deno.env.delete("HOME");
    Deno.env.set("USERPROFILE", "C:\\Users\\testuser");
    assertEquals(getSwampDataDir(), "C:\\Users\\testuser/.swamp");
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    if (originalProfile) Deno.env.set("USERPROFILE", originalProfile);
    else Deno.env.delete("USERPROFILE");
  }
});

Deno.test("getSwampDataDir throws when neither HOME nor USERPROFILE set", () => {
  const originalHome = Deno.env.get("HOME");
  const originalProfile = Deno.env.get("USERPROFILE");
  try {
    Deno.env.delete("HOME");
    Deno.env.delete("USERPROFILE");
    assertThrows(
      () => getSwampDataDir(),
      Error,
      "Cannot determine home directory",
    );
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    if (originalProfile) Deno.env.set("USERPROFILE", originalProfile);
    else Deno.env.delete("USERPROFILE");
  }
});

Deno.test("bundleNamespace: same relative relationship produces same hash", () => {
  // Simulates /var/... vs /private/var/... — different absolute prefixes,
  // same relative relationship
  const hash1 = bundleNamespace(
    "/var/tmp/repo/.swamp/pulled-extensions/models",
    "/var/tmp/repo",
  );
  const hash2 = bundleNamespace(
    "/private/var/tmp/repo/.swamp/pulled-extensions/models",
    "/private/var/tmp/repo",
  );
  assertEquals(hash1, hash2);
});

Deno.test("bundleNamespace: different base dirs produce different hashes", () => {
  const local = bundleNamespace("/repo/extensions/models", "/repo");
  const pulled = bundleNamespace(
    "/repo/.swamp/pulled-extensions/models",
    "/repo",
  );
  assertEquals(local !== pulled, true);
});

Deno.test("bundleNamespace: returns 8-char hex string", () => {
  const hash = bundleNamespace("/repo/extensions/models", "/repo");
  assertEquals(hash.length, 8);
  assertEquals(/^[0-9a-f]{8}$/.test(hash), true);
});
