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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createModelEditRenderer } from "./model_edit.ts";
import { createVaultEditRenderer } from "./vault_edit.ts";
import { createWorkflowEditRenderer } from "./workflow_edit.ts";

await initializeLogging({});

const launch = {
  kind: "launching" as const,
  data: {
    editor: "VS Code",
    path: "/repo/definition.yaml",
    waitsForExit: true,
  },
};

Deno.test("edit renderers: log mode handles launch events", () => {
  createModelEditRenderer("log").handlers().launching(launch);
  createWorkflowEditRenderer("log").handlers().launching(launch);
  createVaultEditRenderer("log").handlers().launching(launch);
});

Deno.test("edit renderers: json mode omits launch events", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message: string) => logs.push(message);
  try {
    createModelEditRenderer("json").handlers().launching(launch);
    createWorkflowEditRenderer("json").handlers().launching(launch);
    createVaultEditRenderer("json").handlers().launching(launch);
    assertEquals(logs, []);
  } finally {
    console.log = originalLog;
  }
});

const completedWithWarning = {
  kind: "completed" as const,
  data: {
    path: "/repo/models/my-model/definition.yaml",
    status: "updated" as const,
    name: "my-model",
    type: "aws/s3-bucket",
    editType: "definition" as const,
    warnings: [
      'typeVersion "1.0" is not a valid CalVer version (expected YYYY.MM.DD.MICRO).',
    ],
  },
};

Deno.test("model edit renderer: json mode carries warnings to the caller", () => {
  // Every command must support both output modes, so a warning that only
  // reached the logger would be invisible to a --json caller
  // (swamp-club#2412).
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message: string) => logs.push(message);
  try {
    createModelEditRenderer("json").handlers().completed(completedWithWarning);
  } finally {
    console.log = originalLog;
  }
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.warnings.length, 1);
  assertStringIncludes(parsed.warnings[0], "1.0");
});

Deno.test("model edit renderer: log mode reports warnings", () => {
  createModelEditRenderer("log").handlers().completed(completedWithWarning);
});

const vaultUpdated = {
  kind: "completed" as const,
  data: {
    path: "/repo/vaults/local_encryption/vault-1.yaml",
    status: "updated" as const,
    name: "my-vault",
    type: "local_encryption",
  },
};

Deno.test("vault edit renderer: log mode reports a stdin update", () => {
  createVaultEditRenderer("log").handlers().completed(vaultUpdated);
});

Deno.test("vault edit renderer: json mode passes a stdin update through without an editor", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message: string) => logs.push(message);
  try {
    createVaultEditRenderer("json").handlers().completed(vaultUpdated);
  } finally {
    console.log = originalLog;
  }
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.status, "updated");
  assertEquals(parsed.name, "my-vault");
  assertEquals("editor" in parsed, false);
});

const vaultRenamed = {
  kind: "completed" as const,
  data: {
    ...vaultUpdated.data,
    name: "renamed",
    renamedFrom: "my-vault",
    secretsMoved: true,
  },
};

Deno.test("vault edit renderer: log mode reports a rename that moved secrets", () => {
  createVaultEditRenderer("log").handlers().completed(vaultRenamed);
});

Deno.test("vault edit renderer: json mode carries the previous name and whether secrets moved", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message: string) => logs.push(message);
  try {
    createVaultEditRenderer("json").handlers().completed(vaultRenamed);
  } finally {
    console.log = originalLog;
  }
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.name, "renamed");
  assertEquals(parsed.renamedFrom, "my-vault");
  assertEquals(parsed.secretsMoved, true);
});
