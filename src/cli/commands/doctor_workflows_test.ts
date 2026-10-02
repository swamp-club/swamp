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
import { buildDoctorWorkflowDirs } from "./doctor_workflows.ts";

Deno.test("buildDoctorWorkflowDirs: only the repo workflows dir is strict", () => {
  const dirs = buildDoctorWorkflowDirs({
    yamlWorkflowsDir: "repo-workflows",
    extensionWorkflowsDir: "extension-workflows",
    sourceWorkflowDirs: ["source-a", "source-b"],
    pulledWorkflowDirs: ["pulled-a"],
  });

  assertEquals(dirs.workflowDirs, ["repo-workflows"]);
  assertEquals(dirs.extensionWorkflowDirs, [
    "extension-workflows",
    "source-a",
    "source-b",
    "pulled-a",
  ]);
});

Deno.test("buildDoctorWorkflowDirs: works with no sources or pulled extensions", () => {
  const dirs = buildDoctorWorkflowDirs({
    yamlWorkflowsDir: "repo-workflows",
    extensionWorkflowsDir: "extension-workflows",
    sourceWorkflowDirs: [],
    pulledWorkflowDirs: [],
  });

  assertEquals(dirs.workflowDirs, ["repo-workflows"]);
  assertEquals(dirs.extensionWorkflowDirs, ["extension-workflows"]);
});
