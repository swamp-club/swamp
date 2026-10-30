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

// `model.usage.summary` and an unlimited `model.output.search` answer for the
// same outputs: over a real repository and through serve's request handling,
// for the same window and principal the summary's counts are what counting the
// search's rows gives (swamp-club#4144).

import { assert, assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  grant,
  saveModel,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

interface SearchRow {
  definitionId: string;
  methodName: string;
  status: string;
  startedAt: string;
}

interface SummaryRow {
  definitionId: string;
  modelName: string;
  executions: number;
  failed: number;
  lastStartedAt: string;
  methods: string[];
}

async function dataOf<T>(
  ctx: ConnectionContext,
  type: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const frames = await sendRequest(ctx, {
    type,
    id: crypto.randomUUID(),
    payload,
  });
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const found = frames.find((frame) => frame.type === type);
  assert(found, `${type} replied: ${JSON.stringify(frames)}`);
  return (found.payload as { data: T }).data;
}

/** Asserts the summary's counts are what counting the search's rows gives. */
async function assertParity(
  ctx: ConnectionContext,
  window: Record<string, unknown>,
): Promise<number> {
  const { results } = await dataOf<{ results: SearchRow[] }>(
    ctx,
    "model.output.search",
    window,
  );
  const { totals, models } = await dataOf<{
    totals: { executions: number; failed: number };
    models: SummaryRow[];
  }>(ctx, "model.usage.summary", window);

  assertEquals(totals, {
    executions: results.length,
    failed: results.filter((r) => r.status === "failed").length,
  });
  assertEquals(
    models.map((m) => m.definitionId).sort(),
    [...new Set(results.map((r) => r.definitionId))].sort(),
  );
  for (const model of models) {
    const own = results.filter((r) => r.definitionId === model.definitionId);
    assertEquals(model.executions, own.length);
    assertEquals(
      model.failed,
      own.filter((r) => r.status === "failed").length,
    );
    assertEquals(model.lastStartedAt, own[0].startedAt);
    assertEquals(
      [...model.methods].sort(),
      [...new Set(own.map((r) => r.methodName))].sort(),
    );
  }
  return results.length;
}

const READ: Grant["actions"] = ["read"];

function saveRun(
  repo: ServeRepo,
  model: Definition,
  methodName: string,
  startedAt: string,
  status: "succeeded" | "failed",
) {
  return repo.repoContext.outputRepo.save(
    repo.modelType,
    methodName,
    ModelOutput.create({
      definitionId: model.id,
      methodName,
      status,
      startedAt: new Date(startedAt),
      provenance: {
        definitionHash: "hash",
        modelVersion: "2026.01.01.1",
        triggeredBy: "manual",
      },
    }),
  );
}

Deno.test("model usage summary: counts match an unlimited output search for the same window and principal", async () => {
  await withServeRepo(async (repo) => {
    const dev = await saveModel(repo, "dev-db");
    const prod = await saveModel(repo, "prod-db", { env: "prod" });
    await saveRun(repo, dev, "sync", "2026-01-01T00:00:00Z", "succeeded");
    await saveRun(repo, dev, "sync", "2026-01-02T00:00:00Z", "failed");
    await saveRun(repo, dev, "check", "2026-01-03T00:00:00Z", "succeeded");
    await saveRun(repo, dev, "sweep", "2026-01-04T00:00:00Z", "failed");
    await saveRun(repo, prod, "sync", "2026-01-05T00:00:00Z", "failed");
    await saveRun(repo, prod, "sync", "2026-01-06T00:00:00Z", "succeeded");

    const allModels = grant({
      actions: READ,
      resource: { kind: "model", pattern: "*" },
    });
    const windows = [
      {},
      { since: "2026-01-02T00:00:00Z" },
      { until: "2026-01-05T00:00:00Z" },
      { since: "2026-01-02T00:00:00Z", until: "2026-01-05T00:00:00Z" },
      { since: "2030-01-01T00:00:00Z" },
    ];

    // Auth off, everything, then with a tag deny and a methods-scoped grant.
    const principals: [string, Grant[] | undefined, number][] = [
      ["auth off", undefined, 6],
      ["every model", [allModels], 6],
      [
        "a tag deny",
        [
          allModels,
          grant({
            effect: "deny",
            actions: READ,
            resource: { kind: "model", pattern: "*" },
            condition: 'tags.env == "prod"',
          }),
        ],
        4,
      ],
      [
        "a methods-scoped grant",
        [grant({
          actions: READ,
          resource: { kind: "model", pattern: "*" },
          methods: ["sync"],
        })],
        4,
      ],
    ];
    for (const [label, grants, unbounded] of principals) {
      const ctx = createServeCtx(repo, grants);
      for (const window of windows) {
        const counted = await assertParity(ctx, window);
        if (Object.keys(window).length === 0) {
          assertEquals(counted, unbounded, label);
        }
      }
    }
  });
});
