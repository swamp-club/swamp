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

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type Client,
  readCommand,
  type Scratch,
  type Serve,
  serveEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";
import type {
  WorkflowRunWorkerMessage,
  WorkflowRunWorkerRequest,
} from "./serve_upstream_workflow_run_worker.ts";

await initializeLogging({});

const RUNS_PER_MEMBER = 4;
const WORKFLOW_NAME = "nightly-report";

// alice-token authenticates as user:caller
const ALICE_ALL: readonly GrantSpec[] = [
  {
    user: "caller",
    actions: ["read", "write", "run"],
    kind: "model",
    pattern: "*",
  },
  { user: "caller", actions: ["read", "write"], kind: "data", pattern: "*" },
  {
    user: "caller",
    actions: ["read", "write", "run"],
    kind: "workflow",
    pattern: "*",
  },
];

// The dogfood member with no write on workflow:*.
const BOB_DOGFOOD: readonly GrantSpec[] = [
  { user: "bob", actions: ["read", "run"], kind: "model", pattern: "*" },
  { user: "bob", actions: ["write"], kind: "model", pattern: "ops-*" },
  { user: "bob", actions: ["read", "write"], kind: "data", pattern: "*" },
  { user: "bob", actions: ["read", "run"], kind: "workflow", pattern: "*" },
];

const BOB_ALL: readonly GrantSpec[] = ALICE_ALL.map((grant) => ({
  ...grant,
  user: "bob",
}));

interface Runs {
  readonly statuses: readonly string[];
  readonly errors: readonly string[];
}

function runWorkflows(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  principal: string,
): Promise<Runs> {
  const worker = new Worker(
    new URL("./serve_upstream_workflow_run_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  let loaded = false;
  let done: Extract<WorkflowRunWorkerMessage, { kind: "done" }> | undefined;
  let failed: string | undefined;
  worker.onmessage = (event: MessageEvent<WorkflowRunWorkerMessage>) => {
    const message = event.data;
    if (message.kind === "loaded") loaded = true;
    else if (message.kind === "done") done = message;
    else failed = message.error;
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failed = event.message;
  };
  return (async () => {
    try {
      await waitFor(
        () => loaded || failed !== undefined,
        `${token}'s worker to load`,
        { timeoutMs: 120_000 },
      );
      worker.postMessage(
        {
          kind: "run",
          configDir: scratch.configDir,
          repoDir: client.repoDir,
          env: {
            ...serveEnv(serve, token),
            SWAMP_SERVE_TIMEOUT_MS: "120000",
          },
          modelType: serve.modelType.normalized,
          workflowName: WORKFLOW_NAME,
          principal,
          count: RUNS_PER_MEMBER,
        } satisfies WorkflowRunWorkerRequest,
      );
      await waitFor(
        () => done !== undefined || failed !== undefined,
        `${token}'s workflow runs`,
        { timeoutMs: 240_000, intervalMs: 50 },
      );
    } finally {
      worker.terminate();
    }
    if (done === undefined) throw new Error(`${token} failed: ${failed}`);
    return done;
  })();
}

async function summaryVersions(serve: Serve): Promise<number[]> {
  const versions = new Set<number>();
  for (const entry of await serve.log()) {
    for (const key of entry.keys) {
      const match = key.match(/\/report-swamp-workflow-summary\/(\d+)\/raw$/);
      if (match !== null) versions.add(Number(match[1]));
    }
  }
  return [...versions].sort((a, b) => a - b);
}

for (
  const [label, bobGrants] of [
    ["bob's dogfood grants", BOB_DOGFOOD],
    ["two full-grant members", BOB_ALL],
  ] as const
) {
  Deno.test({
    name:
      `workflow report race: ${label}: overlapping runs of one workflow all succeed, with the shared report's versions consecutive`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withScratch(async (scratch) => {
        const serve = await scratch.serve({
          grants: [...ALICE_ALL, ...bobGrants],
          managedConfig: true,
        });
        const alice = await scratch.client("a", { managedConfig: true });
        const bob = await scratch.client("b", { managedConfig: true });
        await writeCommand(
          scratch,
          alice,
          serveEnv(serve, "alice-token"),
          (repos) =>
            repos.workflowRepo.save(Workflow.create({
              name: WORKFLOW_NAME,
              jobs: [Job.create({
                name: "main",
                steps: [Step.create({
                  name: "health",
                  task: StepTask.modelMethod("web", "noop"),
                })],
              })],
            })),
        );
        assert(
          await readCommand(
            scratch,
            bob,
            serveEnv(serve, "bob-token"),
            (repos) => repos.workflowRepo.findByName(WORKFLOW_NAME),
          ),
          "bob's copy holds the workflow",
        );
        const [fromAlice, fromBob] = await Promise.all([
          runWorkflows(scratch, serve, alice, "alice-token", "user:caller"),
          runWorkflows(scratch, serve, bob, "bob-token", "user:bob"),
        ]);
        assertEquals([...fromAlice.errors, ...fromBob.errors], []);
        assertEquals(
          [...fromAlice.statuses, ...fromBob.statuses],
          Array(2 * RUNS_PER_MEMBER).fill("succeeded"),
        );
        assertEquals(
          await summaryVersions(serve),
          Array.from({ length: 2 * RUNS_PER_MEMBER }, (_, i) => i + 1),
        );
      });
    },
  });
}
