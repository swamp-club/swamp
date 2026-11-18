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
  PROVISION_CHILD_ARGS,
  provisionFailureMessage,
} from "./workspace_provision_process.ts";

Deno.test("PROVISION_CHILD_ARGS: runs the hidden command in json mode", () => {
  assertEquals(PROVISION_CHILD_ARGS, [
    "serve",
    "provision-workspace",
    "--json",
  ]);
});

Deno.test("provisionFailureMessage: says how the child ended and carries its stderr", () => {
  assertEquals(
    provisionFailureMessage(1, null, []),
    "The provisioner exited with code 1.",
  );
  assertStringIncludes(
    provisionFailureMessage(null, "timed out", ["boom"]),
    "timed out and was killed:\nboom",
  );
  assertStringIncludes(
    provisionFailureMessage(null, "cancelled", []),
    "cancelled and was killed",
  );
  assertStringIncludes(
    provisionFailureMessage(null, null, []),
    "killed by a signal or could not start",
  );
});
