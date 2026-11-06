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
import {
  abortRunHeldOutsideActiveRuns,
  runCancelDecider,
  runCancelResource,
  runResumeDecider,
  workflowHeldOutsideActiveRuns,
} from "./run_cancel_authorization.ts";
import { RunCancelRegistry } from "./run_cancel_registry.ts";
import type { WorkflowRepository } from "../domain/workflows/repositories.ts";

const noWorkflows = {
  findById: () => Promise.resolve(null),
  findByName: () => Promise.resolve(null),
  findAll: () => Promise.resolve([]),
} as unknown as WorkflowRepository;

Deno.test("runCancelResource: a workflow that is gone is decided by its recorded name", async () => {
  const resource = await runCancelResource(noWorkflows, {
    name: "deleted-wf",
  });
  assertEquals(resource?.kind, "workflow");
  assertEquals(resource?.name, "deleted-wf");
});

Deno.test("runCancelResource: a failed lookup answers undefined, which refuses", async () => {
  const failing = {
    ...noWorkflows,
    findByName: () => Promise.reject(new Error("unreadable")),
    findAll: () => Promise.reject(new Error("unreadable")),
    findById: () => Promise.reject(new Error("unreadable")),
  } as unknown as WorkflowRepository;
  assertEquals(
    await runCancelResource(failing, { id: crypto.randomUUID(), name: "n" }),
    undefined,
  );
});

Deno.test("workflowHeldOutsideActiveRuns: names the holder's workflow, attached before a trigger", () => {
  const cancelRegistry = new RunCancelRegistry();
  cancelRegistry.register("workflow-run", "r1", new AbortController(), {
    id: "attached",
    name: "a",
  });
  const trigger = (id: string, name: string) => ({
    workflowOfRun: (r: string) =>
      r === "r1" || r === "r2" ? { id, name } : undefined,
    cancelByRunId: () => true,
  });
  const holders = {
    cancelRegistry,
    scheduledExecution: trigger("scheduled", "s"),
    webhookRuns: trigger("webhook", "w"),
  } as unknown as Parameters<typeof workflowHeldOutsideActiveRuns>[0];
  assertEquals(workflowHeldOutsideActiveRuns(holders, "r1")?.id, "attached");
  assertEquals(workflowHeldOutsideActiveRuns(holders, "r2")?.id, "scheduled");
  assertEquals(workflowHeldOutsideActiveRuns(holders, "r3"), undefined);
});

Deno.test("abortRunHeldOutsideActiveRuns: says false when no holder has the run", () => {
  assertEquals(
    abortRunHeldOutsideActiveRuns(
      { cancelRegistry: new RunCancelRegistry() } as unknown as Parameters<
        typeof abortRunHeldOutsideActiveRuns
      >[0],
      "r1",
      "why",
    ),
    false,
  );
});

Deno.test("run command deciders: with no auth, any caller may", async () => {
  // no restrictedCommands: a listing with auth off must not read them
  const ctx = {
    authConfig: { mode: "none" },
    repoContext: { workflowRepo: noWorkflows },
  } as unknown as Parameters<typeof runResumeDecider>[0];
  const caller = {
    principal: null,
    collectives: [],
    groups: [],
    sourceIp: "ip",
  };
  const target = { name: "wf" };
  assertEquals(await runCancelDecider(ctx, caller)(target), true);
  assertEquals(await runResumeDecider(ctx, caller)(target), true);
});
