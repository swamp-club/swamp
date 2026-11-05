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
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";
import {
  logFromQueryReply,
  stepLogQuery,
} from "../packages/dashboard/src/components/step_log.ts";

await initializeLogging({});

const RUN_ID = crypto.randomUUID();
const BEHAVIOR = `review-comments-${RUN_ID}`;
const JOB = "review";
const STEP = "comments-[src/a.ts]";

/**
 * a step log whose behavior has no definition: the per-run behavior was deleted
 * after the run, the data it wrote was not
 */
async function saveOrphanedLog(
  repo: ServeRepo,
  text: string,
): Promise<{ dataId: string; version: number; tags: Record<string, string> }> {
  const tags = {
    type: "file",
    specName: "log",
    modelName: BEHAVIOR,
    workflowRunId: RUN_ID,
    job: JOB,
    step: STEP,
  };
  const data = Data.create({
    name: "log",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags,
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: `${repo.modelType.normalized}:${MODEL_ID}`,
      workflowRunId: RUN_ID,
      workflowName: "verify-reviews",
      jobName: JOB,
      stepName: STEP,
      source: "step-output",
    },
  });
  const saved = await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    MODEL_ID,
    data,
    new TextEncoder().encode(text),
  );
  return { dataId: data.id, version: saved.version, tags };
}

const MODEL_ID = crypto.randomUUID();

const behaviorReader = (pattern: string): Grant[] => [
  grant({ actions: ["read"], resource: { kind: "data", pattern } }),
];

async function queryStepLog(
  repo: ServeRepo,
  grants: Grant[] | undefined,
  artifact: { dataId: string; version: number; tags: Record<string, string> },
): Promise<Frame[]> {
  const payload = stepLogQuery({ name: "log", ...artifact });
  assert(payload);
  return await sendRequest(createServeCtx(repo, grants), {
    type: "data.query",
    id: crypto.randomUUID(),
    payload,
  });
}

function queryReply(frames: Frame[]): unknown {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const found = frames.find((frame) => frame.type === "data.query");
  assert(found, JSON.stringify(frames));
  return found.payload;
}

Deno.test("serve step log: data.query reads a step's log after its behavior definition is gone", async () => {
  await withServeRepo(async (repo) => {
    const first = await saveOrphanedLog(repo, "[stdout]\nfirst run\n");
    const second = await saveOrphanedLog(repo, "[stdout]\nsecond run\n");
    assertEquals([first.version, second.version], [1, 2]);

    assertEquals(
      logFromQueryReply(queryReply(await queryStepLog(repo, undefined, first))),
      { content: "[stdout]\nfirst run\n", contentEncoding: "utf-8" },
    );
    assertEquals(
      logFromQueryReply(
        queryReply(await queryStepLog(repo, undefined, second)),
      ),
      { content: "[stdout]\nsecond run\n", contentEncoding: "utf-8" },
    );
  });
});

Deno.test("serve step log: an orphaned log is authorized on its recorded behavior name", async () => {
  await withServeRepo(async (repo) => {
    const artifact = await saveOrphanedLog(repo, "[stdout]\nsecret-ish\n");

    const allowed = await queryStepLog(
      repo,
      behaviorReader("review-comments-*"),
      artifact,
    );
    assertEquals(
      logFromQueryReply(queryReply(allowed))?.content,
      "[stdout]\nsecret-ish\n",
    );

    const denied = await queryStepLog(
      repo,
      behaviorReader("someone-else-*"),
      artifact,
    );
    assertEquals(logFromQueryReply(queryReply(denied)), null);
    const body = JSON.stringify(denied);
    assert(!body.includes("secret-ish"), body);
    assert(!body.includes(BEHAVIOR), body);
  });
});
