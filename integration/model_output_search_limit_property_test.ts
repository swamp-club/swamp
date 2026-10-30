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

// A limited output search stops reading once it holds its results
// (swamp-club#4143, swamp-club#4174). That is safe only if it returns exactly what the full
// scan returns once authorized and cut to the limit: the same outputs in the
// same order, whatever ties, names not in the output form, windows and
// permissions the repository holds.

import { assert, assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import fc from "fast-check";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../src/domain/models/access/server_token_model.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  modelOutputSearch,
  type ModelOutputSearchData,
  type ModelOutputSearchDeps,
  type ModelOutputSearchInput,
  type ModelOutputSearchItem,
  type ModelOutputSearchModel,
} from "../src/libswamp/models/output_search.ts";
import { collect } from "../src/libswamp/testing.ts";
// The global output scans walk the registered types.
import "../src/domain/models/models.ts";

const TYPES = [ModelType.create("command/shell"), SERVER_TOKEN_MODEL_TYPE];
const DEFINITIONS = Array.from({ length: 4 }, () => crypto.randomUUID());
const METHODS = ["a-method", "b-method"];
const BASE_MS = Date.UTC(2026, 0, 1);
// The batch a limited search reads at least, however low its limit.
const MIN_BATCH = 16;

interface File {
  type: number;
  definition: number;
  method: number;
  /** Few distinct values, so that many files share a millisecond. */
  offset: number;
  /** Written under a name not in the output form. */
  unnamed: boolean;
}

const file = (unnamed: fc.Arbitrary<boolean>): fc.Arbitrary<File> =>
  fc.record({
    type: fc.nat(TYPES.length - 1),
    definition: fc.nat(DEFINITIONS.length - 1),
    method: fc.nat(METHODS.length - 1),
    offset: fc.nat(12),
    unnamed,
  });

const bound = fc.option(fc.nat(12), { nil: undefined });
const search = fc.record({
  since: bound,
  until: bound,
  limit: fc.nat(60),
  readable: fc.subarray(DEFINITIONS),
});

const isoAt = (offset: number) => new Date(BASE_MS + offset).toISOString();

async function writeFiles(
  repo: YamlOutputRepository,
  files: File[],
): Promise<void> {
  for (const [i, spec] of files.entries()) {
    const type = TYPES[spec.type];
    const method = METHODS[spec.method];
    const output = ModelOutput.create({
      definitionId: createDefinitionId(DEFINITIONS[spec.definition]),
      methodName: method,
      status: "succeeded",
      startedAt: new Date(BASE_MS + spec.offset),
      provenance: {
        definitionHash: "h",
        modelVersion: "1",
        triggeredBy: "manual",
      },
    });
    if (spec.unnamed) {
      const path = join(
        dirname(repo.getPath(type, method, output)),
        `renamed-${i}.yaml`,
      );
      await ensureDir(dirname(path));
      await Deno.writeTextFile(
        path,
        stringifyYaml(JSON.parse(JSON.stringify(output.toData()))),
      );
    } else {
      await repo.save(type, method, output);
    }
  }
}

/** Search deps over `repo` for a caller who may read only `readable`. */
function depsFor(
  repo: YamlOutputRepository,
  readable: readonly string[],
): ModelOutputSearchDeps {
  return {
    findAllOutputsGlobal: (selectReadable) =>
      repo.findAllGlobal(undefined, selectReadable),
    findAllOutputsGlobalSince: (cutoff, selectReadable) =>
      repo.findAllGlobalSince(cutoff, undefined, selectReadable),
    findAllDefinitions: () => Promise.resolve([]),
    canRead: (candidates) =>
      Promise.resolve(
        candidates.map((c) => readable.includes(c.definitionId)),
      ),
  };
}

async function resultsOf(
  deps: ModelOutputSearchDeps,
  input: ModelOutputSearchInput,
): Promise<ModelOutputSearchItem[]> {
  const events = await collect(
    modelOutputSearch(createLibSwampContext(), deps, input),
  );
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  return (last as { data: ModelOutputSearchData }).data.results;
}

async function withRepos(
  fn: (newRepo: () => Promise<YamlOutputRepository>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-output-limit-" });
  try {
    await fn(async () =>
      new YamlOutputRepository(await Deno.makeTempDir({ dir }))
    );
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

Deno.test("modelOutputSearch: a limited search returns what the full scan returns once authorized and cut to the limit", async () => {
  await withRepos(async (newRepo) => {
    await fc.assert(
      fc.asyncProperty(
        // More files than one batch reads, or stopping early is never tested.
        fc.array(file(fc.boolean()), {
          minLength: MIN_BATCH,
          maxLength: 80,
          size: "max",
        }),
        search,
        async (files, { since, until, limit, readable }) => {
          const repo = await newRepo();
          await writeFiles(repo, files);
          const input = {
            since: since === undefined ? undefined : isoAt(since),
            until: until === undefined ? undefined : isoAt(until),
          };
          const allowed = new Set<string>(readable);

          const fullScan = await resultsOf(depsFor(repo, readable), input);
          const expected = fullScan
            .filter((item) => allowed.has(item.definitionId))
            .slice(0, limit);

          const limited = await resultsOf(
            {
              ...depsFor(repo, readable),
              findAllOutputsGlobal: () =>
                Promise.reject(new Error("read every output")),
              findAllOutputsGlobalSince: () =>
                Promise.reject(new Error("read every output")),
              findOutputsNewestFirst: (window, selectReadable) =>
                repo.findGlobalNewestFirst(window, undefined, selectReadable),
            },
            { ...input, limit },
          );

          assertEquals(limited, expected);
        },
      ),
      { numRuns: 60 },
    );
  });
});

Deno.test("modelOutputSearch: without ties or names not in the output form, a limited search reads no more than one batch", async () => {
  await withRepos(async (newRepo) => {
    await fc.assert(
      fc.asyncProperty(
        // Every file its own millisecond, and more files than one batch reads.
        fc.uniqueArray(fc.nat(1000), {
          minLength: MIN_BATCH * 2,
          maxLength: 80,
          size: "max",
        }).map((offsets) =>
          offsets.map((offset, i) => ({
            type: i % TYPES.length,
            definition: i % DEFINITIONS.length,
            method: i % METHODS.length,
            offset,
            unnamed: false,
          }))
        ),
        fc.nat(MIN_BATCH),
        async (files, limit) => {
          const repo = await newRepo();
          await writeFiles(repo, files);
          let read = 0;

          await resultsOf(
            {
              ...depsFor(repo, DEFINITIONS),
              findOutputsNewestFirst: async (window, selectReadable) => {
                const outputs = await repo.findGlobalNewestFirst(
                  window,
                  undefined,
                  selectReadable,
                );
                return {
                  get unread() {
                    return outputs.unread;
                  },
                  unreadStartedBefore: (instant) =>
                    outputs.unreadStartedBefore(instant),
                  next: async (count) => {
                    const batch = await outputs.next(count);
                    read += batch.length;
                    return batch;
                  },
                };
              },
            },
            { limit },
          );

          assert(
            read <= Math.max(limit, MIN_BATCH),
            `read ${read} for a limit of ${limit}`,
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});

/**
 * Deps over `repo` that resolve `model` to `definitions`, for a caller who may
 * read only `readable`.
 */
function modelDepsFor(
  repo: YamlOutputRepository,
  readable: readonly string[],
  definitions: ModelOutputSearchModel[],
): ModelOutputSearchDeps {
  return {
    ...depsFor(repo, readable),
    resolveModel: () => Promise.resolve(definitions),
    findOutputsByDefinition: (type, definitionId, window) =>
      repo.findHistoryByDefinition(
        ModelType.create(type.normalized),
        createDefinitionId(definitionId),
        window,
      ),
  };
}

Deno.test("modelOutputSearch: a limited search for a model returns what the full scan returns once authorized and cut to the limit, however many definitions the filter resolves to", async () => {
  // The filter is the first definition's id: it resolves to that id under each
  // type, and to the model another definition has named with it.
  const model = DEFINITIONS[0];
  const resolvable: ModelOutputSearchModel[] = [
    ...TYPES.map((type) => ({
      definitionId: model,
      name: "by-id",
      type: { normalized: type.normalized },
    })),
    {
      definitionId: DEFINITIONS[1],
      name: model,
      type: { normalized: TYPES[0].normalized },
    },
  ];
  await withRepos(async (newRepo) => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(file(fc.boolean()), {
          minLength: MIN_BATCH,
          maxLength: 80,
          size: "max",
        }),
        search,
        fc.shuffledSubarray(resolvable),
        async (files, { since, until, limit, readable }, definitions) => {
          const repo = await newRepo();
          await writeFiles(repo, files);
          const input = {
            model,
            since: since === undefined ? undefined : isoAt(since),
            until: until === undefined ? undefined : isoAt(until),
          };
          const allowed = new Set<string>(readable);
          const deps = modelDepsFor(repo, readable, definitions);

          const fullScan = await resultsOf(deps, input);
          const expected = fullScan
            .filter((item) => allowed.has(item.definitionId))
            .slice(0, limit);

          const limited = await resultsOf(
            {
              ...deps,
              findOutputsByDefinition: () =>
                Promise.reject(new Error("read the whole model")),
              findOutputsByDefinitionNewestFirst: (
                type,
                definitionId,
                window,
                selectReadable,
              ) =>
                repo.findHistoryNewestFirst(
                  ModelType.create(type.normalized),
                  createDefinitionId(definitionId),
                  window,
                  undefined,
                  selectReadable,
                ),
            },
            { ...input, limit },
          );

          assertEquals(limited, expected);
        },
      ),
      { numRuns: 60 },
    );
  });
});

Deno.test("modelOutputSearch: without ties or names not in the output form, a limited search for a model reads no more than one batch", async () => {
  const model = DEFINITIONS[0];
  await withRepos(async (newRepo) => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.nat(1000), {
          minLength: MIN_BATCH * 2,
          maxLength: 80,
          size: "max",
        }).map((offsets) =>
          offsets.map((offset, i) => ({
            type: 0,
            // Half of them the model's, so a file of another is passed over.
            definition: i % 2,
            method: i % METHODS.length,
            offset,
            unnamed: false,
          }))
        ),
        fc.nat(MIN_BATCH),
        async (files, limit) => {
          const repo = await newRepo();
          await writeFiles(repo, files);
          let read = 0;

          await resultsOf(
            {
              ...modelDepsFor(repo, DEFINITIONS, [{
                definitionId: model,
                name: "by-id",
                type: { normalized: TYPES[0].normalized },
              }]),
              findOutputsByDefinitionNewestFirst: async (
                type,
                definitionId,
                window,
                selectReadable,
              ) => {
                const outputs = await repo.findHistoryNewestFirst(
                  ModelType.create(type.normalized),
                  createDefinitionId(definitionId),
                  window,
                  undefined,
                  selectReadable,
                );
                return {
                  get unread() {
                    return outputs.unread;
                  },
                  unreadStartedBefore: (instant) =>
                    outputs.unreadStartedBefore(instant),
                  next: async (count) => {
                    const batch = await outputs.next(count);
                    read += batch.length;
                    return batch;
                  },
                };
              },
            },
            { model, limit },
          );

          assert(
            read <= Math.max(limit, MIN_BATCH),
            `read ${read} for a limit of ${limit}`,
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});
