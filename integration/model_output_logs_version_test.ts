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
import { Data } from "../src/domain/data/mod.ts";
import type { DefinitionId } from "../src/domain/definitions/definition.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { UnifiedDataRepository } from "../src/domain/data/repositories.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { sha256Hex } from "../src/libswamp/data/run_artifact_check.ts";
import {
  createModelOutputLogsDeps,
  modelOutputLogs,
  type ModelOutputLogsDeps,
  type ModelOutputLogsEvent,
} from "../src/libswamp/models/output_logs.ts";
import { collect } from "../src/libswamp/testing.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";
import { saveModel } from "./serve_request_harness.ts";

const FIRST = new TextEncoder().encode("first run\n");
const SECOND = new TextEncoder().encode("second run\n");

function logData(modelType: ModelType, modelId: string): Data {
  return Data.create({
    name: "run.log",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "log" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${modelType.normalized}:${modelId}`,
    },
  });
}

async function saveTwoVersions(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
): Promise<{ version: number; dataId: string }> {
  const { version } = await repo.save(
    modelType,
    modelId,
    logData(modelType, modelId),
    FIRST,
  );
  await repo.save(modelType, modelId, logData(modelType, modelId), SECOND);
  // the ref must carry the id the repository kept for this version
  const saved = await repo.findByName(modelType, modelId, "run.log", version);
  if (saved === null) throw new Error("the first version was not saved");
  return { version, dataId: saved.id };
}

function outputReferencing(
  modelId: string,
  ref: { dataId: string; version: number; sha256?: string },
): ModelOutput {
  const output = ModelOutput.create({
    definitionId: modelId as DefinitionId,
    methodName: "run",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "manual",
    },
  });
  output.markRunning();
  output.addDataArtifact({
    ...ref,
    name: "run.log",
    tags: { type: "log" },
  });
  output.markSucceeded();
  return output;
}

async function logsOf(
  deps: ModelOutputLogsDeps,
  output: ModelOutput,
  modelType: ModelType,
): Promise<ModelOutputLogsEvent> {
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: output.id,
      reference: { kind: "output", match: { output, type: modelType } },
    }),
  );
  return events[events.length - 1];
}

function linesOf(event: ModelOutputLogsEvent): string[] {
  if (event.kind !== "completed") {
    throw new Error(`expected completed, got ${JSON.stringify(event)}`);
  }
  return event.data.lines;
}

Deno.test("model output logs: an older output on a v2 repo prints its own log version, not the latest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-output-logs-" });
  try {
    const modelType = ModelType.create("test/output-logs");
    const modelId = crypto.randomUUID();
    const repo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      new CatalogStore(":memory:"),
    );
    const ref = await saveTwoVersions(repo, modelType, modelId);
    const deps = createModelOutputLogsDeps(dir, undefined, repo);

    const event = await logsOf(
      deps,
      outputReferencing(modelId, ref),
      modelType,
    );

    assertEquals(linesOf(event), ["first run"]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("model output logs: on a v3 datastore an older output prints its own log version and a ref whose sha256 differs is refused", async () => {
  await withV3RowRepos({}, async (repos) => {
    const { repoContext } = repos.a;
    const { model, ref } = await runInRootUnitOfWork(
      repoContext,
      { flush: undefined },
      async () => {
        const model = await saveModel(repos.serveRepo, "m1");
        const ref = await saveTwoVersions(
          repoContext.unifiedDataRepo,
          repos.modelType,
          model.id,
        );
        return { model, ref };
      },
    );
    const deps = createModelOutputLogsDeps(
      repos.a.repoDir,
      repos.a.datastoreResolver,
      repoContext.unifiedDataRepo,
      repoContext.unreadableContent,
    );
    assertEquals(typeof deps.checkArtifact, "function");

    const own = await logsOf(
      deps,
      outputReferencing(model.id, { ...ref, sha256: await sha256Hex(FIRST) }),
      repos.modelType,
    );
    assertEquals(linesOf(own), ["first run"]);

    const forged = await logsOf(
      deps,
      outputReferencing(model.id, { ...ref, sha256: await sha256Hex(SECOND) }),
      repos.modelType,
    );
    if (forged.kind !== "error") {
      throw new Error(`expected error, got ${JSON.stringify(forged)}`);
    }
    assertEquals(forged.error.code, "not_found");
    assertStringIncludes(forged.error.message, "other content");
  });
});
