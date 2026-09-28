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
 * Integration test for run-scoped data resolution (swamp-club#2601).
 *
 * Wires WorkflowDataService to a real FileSystemUnifiedDataRepository and
 * checks that each workflow run resolves the exact data version it recorded,
 * not the latest version and not a same-named item from another model.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { WorkflowDataService } from "../src/domain/data/workflow_data_service.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import type { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-data-versions-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const type = ModelType.create("test/model");

const noDefinitions = {
  findById: () => Promise.resolve(null),
} as unknown as YamlDefinitionRepository;

function makeData(modelId: string, runId: string): Data {
  return Data.create({
    name: "result",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "result" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: modelId,
      workflowRunId: runId,
    },
  });
}

function makeRun(
  runId: string,
  workflowId: string,
  artifact: { dataId: string; version: number },
): WorkflowRun {
  const now = new Date().toISOString();
  return WorkflowRun.fromData({
    id: runId,
    workflowId,
    workflowName: "wf",
    status: "succeeded",
    startedAt: now,
    completedAt: now,
    jobs: [{
      jobName: "main",
      status: "succeeded",
      steps: [{
        stepName: "write",
        status: "succeeded",
        dataArtifacts: [{
          dataId: artifact.dataId,
          name: "result",
          version: artifact.version,
          tags: { type: "resource", specName: "result" },
        }],
      }],
    }],
  });
}

Deno.test("WorkflowDataService: each run resolves the data version it recorded on disk", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, ".swamp", "data"));
    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    try {
      const repo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        catalog,
      );
      const modelId = crypto.randomUUID();
      const otherModelId = crypto.randomUUID();
      const workflowId = crypto.randomUUID();
      const runA = crypto.randomUUID();
      const runB = crypto.randomUUID();
      const otherRun = crypto.randomUUID();
      const encode = (s: string) => new TextEncoder().encode(s);

      const dataA = makeData(modelId, runA);
      const savedA = await repo.save(type, modelId, dataA, encode('"A"'));
      const dataB = makeData(modelId, runB);
      const savedB = await repo.save(type, modelId, dataB, encode('"B"'));
      // A different model owns data with the same name and version number.
      await repo.save(
        type,
        otherModelId,
        makeData(otherModelId, otherRun),
        encode('"other"'),
      );
      assertEquals([savedA.version, savedB.version], [1, 2]);

      const service = new WorkflowDataService(noDefinitions, repo);
      const runARecord = makeRun(runA, workflowId, {
        dataId: dataA.id,
        version: savedA.version,
      });
      const runBRecord = makeRun(runB, workflowId, {
        dataId: dataB.id,
        version: savedB.version,
      });

      const itemsA = await service.findAllForWorkflowRun(runARecord);
      assertEquals(itemsA.length, 1);
      assertEquals(itemsA[0].modelId, modelId);
      assertEquals(itemsA[0].data.version, 1);
      assertEquals(
        new TextDecoder().decode(
          await repo.getContent(
            type,
            modelId,
            "result",
            itemsA[0].data.version,
          ) ??
            new Uint8Array(),
        ),
        '"A"',
      );

      const itemB = await service.findByNameInWorkflowRun(runBRecord, "result");
      assertEquals(itemB?.modelId, modelId);
      assertEquals(itemB?.data.version, 2);

      assertEquals(
        (await service.findByNameInWorkflowRun(runARecord, "result", 1))?.data
          .version,
        1,
      );
      assertEquals(
        await service.findByNameInWorkflowRun(runARecord, "result", 2),
        null,
      );
    } finally {
      catalog.close();
    }
  });
});
