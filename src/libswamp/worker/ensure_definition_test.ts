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
import { join } from "@std/path";
import { ensureWorkerDefinition } from "./ensure_definition.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../../domain/models/worker/worker_model.ts";
import {
  diagnosticPhases,
  withObservedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";
import { withDiagnosticArea } from "../../domain/diagnostics/diagnostic_phase.ts";
import "../../domain/models/models.ts";

async function withWorkerRepo(
  fn: (
    dir: string,
    ctx: ReturnType<typeof createRepositoryContext>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-ensure-worker-def-" });
  const ctx = createRepositoryContext({ repoDir: dir, enableIndexing: false });
  try {
    await fn(dir, ctx);
  } finally {
    ctx.catalogStore.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("ensureWorkerDefinition: creates the worker definition the enroll run then finds by its name file", async () => {
  await withWorkerRepo(async (dir, ctx) => {
    await ensureWorkerDefinition(dir, ctx, "ci-runner-3-ab12");

    await withObservedSpans(async (spans) => {
      const found = await withDiagnosticArea(
        "enrollment",
        () =>
          ctx.definitionRepo.findByName(
            WORKER_MODEL_TYPE,
            workerDefinitionName("ci-runner-3-ab12"),
          ),
      );
      assertEquals(found?.name, workerDefinitionName("ci-runner-3-ab12"));
      const [lookup] = diagnosticPhases(spans, "definition_lookup");
      assertEquals(
        lookup.attributes["swamp.diagnostic.lookup_method"],
        "secondary_name_file",
      );
    });
  });
});

Deno.test("ensureWorkerDefinition: concurrent and repeated calls for one name leave one definition", async () => {
  await withWorkerRepo(async (dir, ctx) => {
    await Promise.all([
      ensureWorkerDefinition(dir, ctx, "ci-runner-3"),
      ensureWorkerDefinition(dir, ctx, "ci-runner-3"),
    ]);
    await ensureWorkerDefinition(dir, ctx, "ci-runner-3");
    const stored: string[] = [];
    for await (
      const entry of Deno.readDir(
        join(ctx.autoDefinitionsDir, WORKER_MODEL_TYPE.toDirectoryPath()),
      )
    ) {
      stored.push(entry.name);
    }
    assertEquals(stored, [`${workerDefinitionName("ci-runner-3")}.yaml`]);
  });
});
