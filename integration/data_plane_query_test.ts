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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import type { VaultService } from "../src/domain/vaults/vault_service.ts";
import { DataPlaneClient } from "../src/worker/data_plane_client.ts";
import {
  MAX_WORKER_READ_BODY_BYTES,
  WORKER_QUERY_PATH,
} from "../src/domain/remote/protocol.ts";
import {
  saveModel,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const GRANT_TYPE = ModelType.create("@swamp/grant");
const WORKER = "w-reader";
const RECORDS = 24;
const RECORD_PAD_BYTES = 256 * 1024;
const OUTPUTS = 40;
// small enough that every read here spans several pages
const READ_PAGE_SIZE = 5;

interface Fixture {
  repo: ServeRepo;
  modelName: string;
  definitionId: string;
  client: DataPlaneClient;
  baseUrl: string;
  capabilities: CapabilityService;
}

async function saveGrant(repo: ServeRepo): Promise<void> {
  const autoDefinitions = new YamlDefinitionRepository(
    repo.repoDir,
    undefined,
    join(repo.repoDir, ".swamp", "auto-definitions"),
    false,
  );
  const definition = Definition.create({
    name: "a-grant",
    globalArguments: {},
  });
  await autoDefinitions.save(GRANT_TYPE, definition);
  await repo.repoContext.unifiedDataRepo.save(
    GRANT_TYPE,
    definition.id,
    Data.create({
      name: "grant-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "a-grant" },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${GRANT_TYPE.normalized}:${definition.id}`,
      },
    }),
    new TextEncoder().encode(JSON.stringify({ secret: "grant-secret" })),
  );
}

async function saveRecord(
  repo: ServeRepo,
  modelId: string,
  modelName: string,
  index: number,
  padBytes = RECORD_PAD_BYTES,
): Promise<void> {
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    modelId,
    Data.create({
      name: `record-${index}`,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${repo.modelType.normalized}:${modelId}`,
      },
    }),
    new TextEncoder().encode(
      JSON.stringify({ index, pad: "p".repeat(padBytes) }),
    ),
  );
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  await withServeRepo(async (repo) => {
    const modelName = `big-${crypto.randomUUID().slice(0, 8)}`;
    const model = await saveModel(repo, modelName);
    for (let i = 0; i < RECORDS; i++) {
      await saveRecord(repo, model.id, modelName, i);
    }
    for (let i = 0; i < OUTPUTS; i++) {
      const output = ModelOutput.create({
        definitionId: createDefinitionId(model.id),
        methodName: "run",
        provenance: {
          definitionHash: "abc",
          modelVersion: "1",
          triggeredBy: "workflow",
        },
      });
      await repo.repoContext.outputRepo.save(repo.modelType, "run", output);
    }
    await saveGrant(repo);

    const dispatches = new DispatchRegistry();
    dispatches.register({
      workerName: WORKER,
      dispatchId: `d-${WORKER}`,
      leaseId: `l-${WORKER}`,
      modelDef: {} as never,
      modelType: repo.modelType,
      modelId: model.id,
      methodName: "run",
      definitionName: modelName,
      definitionTags: {},
    });
    const noVault = () =>
      Promise.reject(new Error("no vault")) as Promise<VaultService>;
    const capabilities = new CapabilityService({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      dispatches,
      createVaultService: noVault,
      readPageSize: READ_PAGE_SIZE,
    });
    const plane = new DataPlane({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      sessions: {
        verify: (credential) =>
          credential === WORKER
            ? { workerId: WORKER, dispatchId: `d-${WORKER}` }
            : null,
      },
      dispatches,
      bundles: new BundleRegistry(),
      workerReads: capabilities,
      createVaultService: noVault,
    });
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      async (req) =>
        (await plane.handle(req)) ?? new Response("Not found", { status: 404 }),
    );
    const baseUrl = `http://127.0.0.1:${server.addr.port}/`;
    try {
      await fn({
        repo,
        modelName,
        definitionId: model.id,
        client: new DataPlaneClient({ baseUrl, credential: () => WORKER }),
        baseUrl,
        capabilities,
      });
    } finally {
      await server.shutdown();
    }
  });
}

Deno.test("data plane query: a multi-MiB readModelData-shaped reply arrives complete over the data plane", async () => {
  await withFixture(async (f) => {
    const records = await f.client.queryData({
      predicate: `modelName == ${JSON.stringify(f.modelName)}`,
      options: { loadAttributes: true },
    }) as { attributes: { index: number; pad: string } }[];
    assertEquals(records.length, RECORDS);
    const indexes = records.map((r) => r.attributes.index).sort((a, b) =>
      a - b
    );
    assertEquals(indexes, Array.from({ length: RECORDS }, (_, i) => i));
    for (const record of records) {
      assertEquals(record.attributes.pad.length, RECORD_PAD_BYTES);
    }
  });
});

Deno.test("data plane query: control-plane records stay hidden through the route", async () => {
  await withFixture(async (f) => {
    const direct = await f.repo.repoContext.dataQueryService.query(
      'modelType == "@swamp/grant"',
    );
    assert(direct.length > 0, "precondition: the grant record exists");
    assertEquals(
      await f.client.queryData({ predicate: 'modelType == "@swamp/grant"' }),
      [],
    );
    assertEquals(
      await f.client.readOutputList({ modelType: "@swamp/grant" }),
      [],
    );
  });
});

Deno.test("data plane query: a select projection is refused with the capability's message", async () => {
  await withFixture(async (f) => {
    const error = await assertRejects(
      () =>
        f.client.queryData({ predicate: "true", options: { select: "name" } }),
      Error,
      "failed (400)",
    );
    assert(
      error.message.includes("Select projections are not permitted"),
      error.message,
    );
  });
});

Deno.test("data plane query: an oversize body is refused before it is parsed", async () => {
  await withFixture(async (f) => {
    await assertRejects(
      () =>
        f.client.queryData({
          predicate: "p".repeat(MAX_WORKER_READ_BODY_BYTES + 1),
        }),
      Error,
      "failed (413)",
    );
  });
});

Deno.test("data plane query: a request without a session credential is refused", async () => {
  await withFixture(async (f) => {
    const response = await fetch(new URL(WORKER_QUERY_PATH, f.baseUrl), {
      method: "POST",
      body: JSON.stringify({ predicate: "true" }),
    });
    await response.body?.cancel();
    assertEquals(response.status, 401);
  });
});

Deno.test("data plane query: output list reads arrive complete and single-record shapes are refused", async () => {
  await withFixture(async (f) => {
    const stored = await f.repo.repoContext.outputRepo.findAll(
      f.repo.modelType,
    );
    assert(stored.length > 1, "precondition: several outputs are stored");
    const ids = (outputs: unknown[]) =>
      outputs.map((o) => String((o as { id: unknown }).id)).sort();
    const all = await f.client.readOutputList({
      modelType: f.repo.modelType.normalized,
    });
    assertEquals(ids(all), stored.map((o) => String(o.id)).sort());
    const byDefinition = await f.client.readOutputList({
      modelType: f.repo.modelType.normalized,
      definitionId: f.definitionId,
    });
    assertEquals(ids(byDefinition), ids(all));
    await assertRejects(
      () =>
        f.client.readOutputList({
          modelType: f.repo.modelType.normalized,
          definitionId: f.definitionId,
          latestOnly: true,
        }),
      Error,
      "failed (400)",
    );
  });
});

Deno.test("data plane query: a reply spanning many pages arrives once each, in createdAt order", async () => {
  await withFixture(async (f) => {
    const records = await f.client.queryData({
      predicate: `modelName == ${JSON.stringify(f.modelName)}`,
    }) as { name: string; createdAt: string }[];
    assertEquals(records.length, RECORDS);
    assertEquals(new Set(records.map((r) => r.name)).size, RECORDS);
    const createdAt = records.map((r) => r.createdAt);
    assertEquals(createdAt, [...createdAt].sort());
  });
});

Deno.test("data plane query: a worker limit spanning pages returns exactly that many records", async () => {
  await withFixture(async (f) => {
    const limit = READ_PAGE_SIZE * 2 + 2;
    const records = await f.client.queryData({
      predicate: `modelName == ${JSON.stringify(f.modelName)}`,
      options: { limit },
    });
    assertEquals(records.length, limit);
  });
});

Deno.test("data plane query: paging is not a snapshot, so a version written between pages appears after its predecessor", async () => {
  await withFixture(async (f) => {
    const seen: { name: string; version: number }[] = [];
    let wrote = false;
    for await (
      const page of f.capabilities.streamQueryData(WORKER, {
        predicate: `modelName == ${JSON.stringify(f.modelName)}`,
      })
    ) {
      seen.push(...page as { name: string; version: number }[]);
      if (!wrote) {
        wrote = true;
        await saveRecord(f.repo, f.definitionId, f.modelName, 0, 16);
      }
    }
    const first = seen.findIndex((r) => r.name === "record-0");
    const rewritten = seen.findIndex((r) =>
      r.name === "record-0" && r.version === 2
    );
    assert(first !== -1 && first < READ_PAGE_SIZE, "record-0 v1 on page 1");
    assert(rewritten > first, "the new version arrives after its predecessor");
    assertEquals(seen.length, RECORDS + 1);
  });
});
