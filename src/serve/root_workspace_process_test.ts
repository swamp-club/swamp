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

import { assert, assertEquals } from "@std/assert";
import { ROOT_WORKSPACE_NAME } from "./host/root_workspace.ts";
import {
  parseWorkspaceCreateOutput,
  rootWorkspaceCreateArgs,
  workspaceCreateFailure,
} from "./root_workspace_process.ts";

Deno.test("rootWorkspaceCreateArgs: runs swamp workspace create for the name in json mode", () => {
  assertEquals(rootWorkspaceCreateArgs(ROOT_WORKSPACE_NAME), [
    "workspace",
    "create",
    ROOT_WORKSPACE_NAME,
    "--json",
  ]);
});

Deno.test("parseWorkspaceCreateOutput: reads the folder, and refuses output that names none", () => {
  assertEquals(
    parseWorkspaceCreateOutput(
      '{\n  "name": "host-root",\n  "path": "/w/host-root"\n}\n',
    ),
    "/w/host-root",
  );
  for (
    const output of ["", "Created workspace", '{"name": "host-root"}', "[]"]
  ) {
    let threw = false;
    try {
      parseWorkspaceCreateOutput(output);
    } catch {
      threw = true;
    }
    assert(threw, `refuses ${JSON.stringify(output)}`);
  }
});

Deno.test("workspaceCreateFailure: prefers the child's own JSON error, else how it ended and its tail", () => {
  assertEquals(
    workspaceCreateFailure(
      1,
      false,
      '{\n  "error": "A workspace folder is already at /w/host-root.",\n  "code": "folder_exists"\n}\n',
    ),
    "A workspace folder is already at /w/host-root.",
  );
  assertEquals(
    workspaceCreateFailure(2, false, "panic\n\nat line 3\n"),
    "swamp workspace create exited with code 2:\npanic\nat line 3",
  );
  assertEquals(
    workspaceCreateFailure(null, true, '{"error": "ignored"}'),
    'swamp workspace create timed out and was killed:\n{"error": "ignored"}',
  );
  assertEquals(
    workspaceCreateFailure(null, false, ""),
    "swamp workspace create was killed by a signal or could not start.",
  );
});
