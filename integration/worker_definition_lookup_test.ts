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
 * Serve's worker definitions resolved through the real wiring: the worker run
 * deps' type-scoped lookup, the repository's auto-definitions name index, and
 * resolveOrCreateDefinition's lock (swamp-club#3984). A worker name new to
 * the repository reads only the files stored since the last lookup, while
 * legacy uuid-named and non-filename-safe definitions are still adopted.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import "../src/domain/models/models.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import {
  type DirectExecutionResult,
  resolveOrCreateDefinition,
} from "../src/libswamp/models/direct_execution.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  WORKER_MODEL_TYPE,
  workerModel,
} from "../src/domain/models/worker/worker_model.ts";
import {
  type ReadableSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";

const STORED = 40;

async function writeWorkerDefinition(
  typeDir: string,
  file: string,
  name: string,
  id: string = crypto.randomUUID(),
): Promise<string> {
  await Deno.writeTextFile(
    join(typeDir, file),
    `type: ${WORKER_MODEL_TYPE.normalized}\nid: ${id}\nname: ${name}\nversion: 1\ntags: {}\nglobalArguments: {}\nmethods: {}\n`,
  );
  return id;
}

/** How many files the name index read across the captured spans. */
function filesParsed(spans: readonly ReadableSpan[]): number {
  return spans
    .filter((s) => s.name === "swamp.definition.name_index.validate")
    .reduce(
      (sum, s) => sum + Number(s.attributes["name_index.files_parsed"] ?? 0),
      0,
    );
}

Deno.test("integration: serve's worker definitions resolve through the auto-definitions name index (swamp-club#3984)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-worker-lookup-" });
  const ctx = createRepositoryContext({ repoDir: dir, enableIndexing: false });
  try {
    const typeDir = join(
      ctx.autoDefinitionsDir,
      WORKER_MODEL_TYPE.toDirectoryPath(),
    );
    await ensureDir(typeDir);
    for (let i = 0; i < STORED; i++) {
      await writeWorkerDefinition(
        typeDir,
        `worker-fleet-${i}.yaml`,
        `worker-fleet-${i}`,
      );
    }
    const legacyId = crypto.randomUUID();
    await writeWorkerDefinition(
      typeDir,
      `${legacyId}.yaml`,
      "worker-legacy",
      legacyId,
    );
    const oddId = crypto.randomUUID();
    await writeWorkerDefinition(typeDir, `${oddId}.yaml`, "Worker Odd", oddId);

    const runDeps = await createWorkerModelRunDeps(dir, ctx, {
      definitionType: WORKER_MODEL_TYPE,
    });
    // As modelMethodRun adapts the run deps for direct type execution.
    const deps = {
      lookupDefinition: runDeps.lookupDefinition,
      getModelDef: runDeps.getModelDef,
      saveDefinition: runDeps.createAndSaveDefinition!,
      getDefinitionPath: runDeps.getDefinitionPath!,
    };
    const resolve = (name: string): Promise<DirectExecutionResult> =>
      resolveOrCreateDefinition(
        deps,
        WORKER_MODEL_TYPE.normalized,
        name,
        "enroll",
        {},
        WORKER_MODEL_TYPE,
        workerModel,
        undefined,
        ctx.autoDefinitionsDir,
      );

    // Stored under their ids: only the index can find them by name.
    const legacy = await resolve("worker-legacy");
    assertEquals(legacy.ok && !legacy.created, true);
    assertEquals(legacy.ok && (legacy.definition.id as string), legacyId);
    const odd = await resolve("Worker Odd");
    assertEquals(odd.ok && !odd.created, true);
    assertEquals(odd.ok && (odd.definition.id as string), oddId);

    const first = await resolve("worker-new-1");
    assertEquals(first.ok && first.created, true);

    await withCapturedSpans(async (spans) => {
      const second = await resolve("worker-new-2");
      assertEquals(second.ok && second.created, true);
      // No stored definition is read again but the one created since, and
      // the two stored under their ids while their stats are too recent to
      // trust (each check reads those again until they settle).
      const parsed = filesParsed(spans);
      assertEquals(parsed >= 1 && parsed <= 5, true, `read ${parsed} files`);
    });

    // Created at their name-derived paths, so their lookups are direct.
    const again = await resolve("worker-new-1");
    assertEquals(again.ok && !again.created, true);
    assertEquals(
      again.ok && again.definition.id,
      first.ok && first.definition.id,
    );
  } finally {
    ctx.catalogStore.close();
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
