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
import { gateContext, type WorkflowJobDef } from "./gate_dag.ts";

const jobs: WorkflowJobDef[] = [
  { name: "build", dependsOn: [], steps: [{ name: "compile" }] },
  {
    name: "approve",
    dependsOn: [{ job: "build" }],
    steps: [{ name: "sign-off" }],
  },
  { name: "deploy", dependsOn: [{ job: "approve" }], steps: [{ name: "go" }] },
  { name: "notify", dependsOn: [{ job: "deploy" }, "approve"], steps: [] },
  { name: "docs", dependsOn: [{ job: "build" }], steps: [] },
];

Deno.test("gateContext: finds the gate's job, what runs next and everything downstream", () => {
  const ctx = gateContext(jobs, "sign-off");
  assertEquals(ctx.gateJob, "approve");
  assertEquals(ctx.next, ["deploy", "notify"]);
  assertEquals(ctx.downstream, ["deploy", "notify"]);
  assertEquals(ctx.highlight, ["approve", "deploy", "notify"]);
  const status = Object.fromEntries(ctx.nodes.map((n) => [n.id, n.status]));
  assertEquals(status, {
    build: undefined,
    approve: "suspended",
    deploy: "waiting",
    notify: "waiting",
    docs: undefined,
  });
  assertEquals(ctx.edges.length, 5);
});

Deno.test("gateContext: an unknown step highlights nothing", () => {
  const ctx = gateContext(jobs, "missing");
  assertEquals(ctx.gateJob, null);
  assertEquals(ctx.next, []);
  assertEquals(ctx.highlight, []);
  assertEquals(ctx.nodes.every((n) => n.status === undefined), true);
});
