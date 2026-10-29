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

// Output search names history from one scan of every definition, with the
// real definition repository: primary definitions over auto-definitions, by
// type and id, however many deleted definitions the history holds
// (swamp-club#3959). A search that may not read everything is judged on
// those same names before it reads (swamp-club#4142).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createDefinitionId,
  Definition,
} from "../src/domain/definitions/definition.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import {
  captureUnreadableWarnings,
  fakeUnreadableLookup,
} from "../src/infrastructure/persistence/unreadable_records_test_helpers.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  modelOutputSearch,
  type ModelOutputSearchData,
  type ModelOutputSearchDeps,
  type ModelOutputSearchSelector,
} from "../src/libswamp/models/output_search.ts";
import { collect } from "../src/libswamp/testing.ts";
// The global output scans walk the registered types.
import "../src/domain/models/models.ts";

const TYPE = ModelType.create("command/shell");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-output-names-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Search deps over `definitionIds`' outputs, counting definition scans. */
function searchDeps(
  repo: YamlDefinitionRepository,
  definitionIds: string[],
): { deps: ModelOutputSearchDeps; scans: () => number } {
  let scans = 0;
  const deps: ModelOutputSearchDeps = {
    findAllOutputsGlobal: () =>
      Promise.resolve(definitionIds.map((definitionId, i) => ({
        output: {
          id: `out-${i}`,
          definitionId,
          methodName: "execute",
          status: "succeeded",
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        },
        type: { normalized: TYPE.normalized },
      }))),
    findAllDefinitions: () => {
      scans++;
      return repo.findAllIncludingAutoGlobal();
    },
  };
  return { deps, scans: () => scans };
}

/** Each output's definition id and the name the search gave it. */
async function namesOf(
  deps: ModelOutputSearchDeps,
): Promise<Map<string, string | undefined>> {
  const events = await collect(
    modelOutputSearch(createLibSwampContext(), deps, {}),
  );
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  const { results } = (last as { data: ModelOutputSearchData }).data;
  return new Map(results.map((r) => [r.definitionId, r.modelName]));
}

Deno.test("model output search: names history from one definition scan, primary definitions over auto-definitions", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
    );
    const autoRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      autoDir,
      false,
    );
    const primary = Definition.create({ name: "primary" });
    await repo.save(TYPE, primary);
    // An auto-definition sharing the primary one's id, and one of its own.
    await autoRepo.save(
      TYPE,
      Definition.create({ id: primary.id, name: "auto-copy" }),
    );
    const autoOnly = Definition.create({ name: "auto-only" });
    await autoRepo.save(TYPE, autoOnly);
    assertEquals((await repo.findAllByIdGlobal(primary.id)).length, 2);

    const deleted = Array.from({ length: 40 }, () => crypto.randomUUID());
    const { deps, scans } = searchDeps(repo, [
      primary.id,
      autoOnly.id,
      ...deleted,
    ]);
    const names = await namesOf(deps);

    assertEquals(scans(), 1);
    assertEquals(names.get(primary.id), "primary");
    assertEquals(names.get(autoOnly.id), "auto-only");
    for (const id of deleted) assertEquals(names.get(id), undefined);
  });
});

Deno.test("model output search: an auto-definition stored under its id the datastore could not materialise leaves its outputs unnamed instead of failing the search", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const lostId = crypto.randomUUID();
    const lostPath = join(autoDir, TYPE.toDirectoryPath(), `${lostId}.yaml`);
    const { lookup } = fakeUnreadableLookup([lostPath]);
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
      undefined,
      lookup,
    );
    const kept = Definition.create({ name: "kept" });
    await repo.save(TYPE, kept);

    const { deps } = searchDeps(repo, [kept.id, lostId]);
    let names = new Map<string, string | undefined>();
    const warnings = await captureUnreadableWarnings(async () => {
      names = await namesOf(deps);
    });

    assertEquals(names.get(kept.id), "kept");
    assertEquals(names.has(lostId), true);
    assertEquals(names.get(lostId), undefined);
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], lostPath);
  });
});

Deno.test("model output search: with canRead, the real repositories leave unread what it refuses, judged on the names the results carry, and answer as filtering every result does (swamp-club#4142)", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const definitionRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
    );
    const autoRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      autoDir,
      false,
    );
    const outputRepo = new YamlOutputRepository(dir);
    const primary = Definition.create({ name: "primary" });
    await definitionRepo.save(TYPE, primary);
    // Shadowed by the primary definition: its outputs carry "primary".
    await autoRepo.save(
      TYPE,
      Definition.create({ id: primary.id, name: "auto-copy" }),
    );
    const other = Definition.create({ name: "other" });
    await definitionRepo.save(TYPE, other);
    const deleted = crypto.randomUUID();
    let at = Date.UTC(2026, 0, 1);
    for (const definitionId of [primary.id, other.id, deleted, primary.id]) {
      await outputRepo.save(
        TYPE,
        "execute",
        ModelOutput.create({
          definitionId: createDefinitionId(definitionId),
          methodName: "execute",
          status: "succeeded",
          startedAt: new Date(at += 1000),
          provenance: {
            definitionHash: "h",
            modelVersion: "1",
            triggeredBy: "manual",
          },
        }),
      );
    }

    const asked: (string | undefined)[] = [];
    const readable = (item: { modelName?: string; definitionId: string }) =>
      item.modelName === "primary" || item.definitionId === deleted;
    const deps = (canRead?: ModelOutputSearchDeps["canRead"]) => ({
      findAllOutputsGlobal: (selectReadable?: ModelOutputSearchSelector) =>
        outputRepo.findAllGlobal(undefined, selectReadable),
      findAllOutputsGlobalSince: (
        cutoff: Date,
        selectReadable?: ModelOutputSearchSelector,
      ) => outputRepo.findAllGlobalSince(cutoff, undefined, selectReadable),
      findAllDefinitions: () => definitionRepo.findAllIncludingAutoGlobal(),
      canRead,
    });
    const resultsOf = async (searchDeps: ModelOutputSearchDeps) => {
      const events = await collect(
        modelOutputSearch(createLibSwampContext(), searchDeps, {
          since: "2025-12-01T00:00:00Z",
        }),
      );
      const last = events[events.length - 1];
      assertEquals(last.kind, "completed");
      return (last as { data: ModelOutputSearchData }).data.results;
    };

    const everything = await resultsOf(deps());
    const filtered = await resultsOf(deps((candidates) => {
      asked.push(...candidates.map((c) => c.modelName));
      return Promise.resolve(candidates.map(readable));
    }));

    assertEquals(filtered, everything.filter(readable));
    assertEquals(filtered.length, 3);
    assertEquals(asked.sort(), ["other", "primary", undefined].sort());
  });
});
