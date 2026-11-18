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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { renderServeProvisionWorkspace } from "./serve_provision_workspace.ts";

await initializeLogging({});

Deno.test("renderServeProvisionWorkspace: json mode prints one line saying the repo is set up", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderServeProvisionWorkspace("json", { dir: "/srv/host/workspaces/x" });
  } finally {
    console.log = origLog;
  }
  assertEquals(output.length, 1);
  assertEquals(JSON.parse(output[0]), {
    provisioned: true,
    dir: "/srv/host/workspaces/x",
  });
});

Deno.test("renderServeProvisionWorkspace: log mode writes nothing to stdout", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderServeProvisionWorkspace("log", { dir: "/srv/host/workspaces/x" });
  } finally {
    console.log = origLog;
  }
  assertEquals(output, []);
});
