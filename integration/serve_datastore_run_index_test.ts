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

/**
 * Serve's run search after a forwarded commit changes a run (swamp-club#3985):
 * the run index serve answers `workflow run search` and `workflow history
 * search` from follows the run record the catch-up wrote, rather than the
 * status it indexed before.
 */

import { assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { grant } from "./serve_request_harness.ts";
import {
  commitBody,
  post,
  type Server,
  withServer,
} from "./serve_datastore_api_harness.ts";

const WORKFLOW = "55555555-6666-4777-8888-999999999999";

function yamlBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(
    stringifyYaml(JSON.parse(JSON.stringify(value))),
  );
  return btoa(String.fromCharCode(...bytes));
}

/** Forwards the run record `runId` with `status`, as a client saves it. */
async function forwardRun(
  server: Server,
  runId: string,
  kind: "run.create" | "run.update",
  status: string,
): Promise<void> {
  const partition = partitionOf({ kind: "run", workflowId: WORKFLOW, runId });
  const head = await server.v3.commitStore.head(server.v3.namespace, partition);
  const answer = await post(
    `${server.url}/partitions/${
      encodeURIComponent(partition.toString())
    }/commits`,
    "alice-token",
    commitBody({
      expectedSeq: head.seq,
      txnId: crypto.randomUUID(),
      ops: [{
        kind: "put",
        intent: { kind, run: { workflowId: WORKFLOW, runId } },
        key: `workflow-runs/${WORKFLOW}/workflow-run-${runId}.yaml`,
        inline: yamlBase64({
          id: runId,
          workflowId: WORKFLOW,
          workflowName: "deploy",
          status,
          tags: {},
          jobs: [],
          startedAt: "2026-10-26T00:00:00.000Z",
        }),
      }],
      chunks: [],
    }),
  );
  assertEquals(answer.status, 200, JSON.stringify(answer.json));
  assertEquals(answer.json.warning, undefined, JSON.stringify(answer.json));
}

const runWorkflows = grant({
  actions: ["read", "run"],
  resource: { kind: "workflow", pattern: "*" },
});

Deno.test({
  name:
    "serve run index: a forwarded commit that changes a run's status is what serve's run search reports next",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([runWorkflows], async (server) => {
      const runs = server.ctx.repoContext.workflowRunRepo;
      const workflowId = createWorkflowId(WORKFLOW);
      const statusOf = async (runId: string) => ({
        search: (await runs.runIndexSnapshot(workflowId)).get(runId)?.summary
          .status,
        history: (await runs.findAllSummariesFromIndex(workflowId)).find((
          summary,
        ) => summary.id === runId)?.status,
      });

      const runId = crypto.randomUUID();
      await forwardRun(server, runId, "run.create", "interrupted");
      // Indexed and cached as serve's searches read it.
      assertEquals(await statusOf(runId), {
        search: "interrupted",
        history: "interrupted",
      });
      assertEquals(await statusOf(runId), {
        search: "interrupted",
        history: "interrupted",
      });

      // A `workflow recover` on a client turns it suspended.
      await forwardRun(server, runId, "run.update", "suspended");
      assertEquals(await statusOf(runId), {
        search: "suspended",
        history: "suspended",
      });
    });
  },
});
