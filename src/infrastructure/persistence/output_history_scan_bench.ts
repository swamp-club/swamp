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
 * The behavior history scan behind serve's `model.output.search` with
 * `since: "7d"` (swamp-club#4056): `findAllGlobalSince` over repositories of
 * growing size, 2% of whose outputs started inside the window. Each size is
 * read with the records' mtimes at their completion, with every mtime fresh
 * (as after a v3 read-model replay), and fresh under event-loop contention
 * from four tasks that each await a stat and then hold the loop for 0.25 ms.
 * One model's history with the same `since` (swamp-club#4058),
 * `findHistoryByDefinition`, is read the same ways, from that repository
 * ("spread": 200 models over 20 types) and from one where a single type holds
 * two models ("busy"). Run with:
 *
 *   deno bench --allow-all src/infrastructure/persistence/output_history_scan_bench.ts
 *   deno bench --allow-all src/infrastructure/persistence/output_history_scan_bench.ts -- 10000,50000,200000
 *
 * Files stat'ed and read per iteration are printed when the run ends: they
 * should stay at zero stats and the in-window count of reads (of the model's
 * outputs, for a model's history) whatever the repository size.
 *
 * Those read the records, with the output summaries disabled. The "whole
 * window" group (swamp-club#4145) has every output inside the window, read
 * from the records and then from warm summaries, which should read none.
 */

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  createDefinitionId,
  type DefinitionId,
} from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { OUTPUT_SUMMARIES_DIR } from "./output_summary_index.ts";
import { swampPath } from "./paths.ts";
import { createRepositoryContext } from "./repository_factory.ts";
import type { YamlOutputRepository } from "./yaml_output_repository.ts";
import "../../domain/models/models.ts";

const SIZES = (Deno.args[0] ?? "10000,50000").split(",").map(Number);
const IN_WINDOW = 0.02;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTENDERS = 4;
const CONTENTION_MS = 0.25;

await modelRegistry.ensureLoaded();
const types = [...modelRegistry.types()].slice(0, 20);
const now = Date.now();
const cutoff = new Date(now - 7 * DAY_MS);
const root = await Deno.makeTempDir({ prefix: "swamp_history_scan_bench_" });

/**
 * A repository of `size` outputs of `models` models over the first
 * `typeCount` types, their mtimes at completion or now, with the first model
 * and its type. `inWindow` is the share of them started inside the window.
 * With `summaries` the repository keeps output summaries.
 */
async function seed(
  size: number,
  fresh: boolean,
  models = 200,
  typeCount = types.length,
  inWindow = IN_WINDOW,
  summaries = false,
): Promise<
  { repo: YamlOutputRepository; definitionId: DefinitionId; type: ModelType }
> {
  const repoDir = join(
    root,
    `${size}-${models}-${fresh ? "fresh" : "settled"}-${inWindow}-${summaries}`,
  );
  if (!summaries) {
    // A file where their directory would go keeps them from being used.
    await ensureDir(swampPath(repoDir));
    await Deno.writeTextFile(swampPath(repoDir, OUTPUT_SUMMARIES_DIR), "");
  }
  const repo = createRepositoryContext({ repoDir, enableIndexing: false })
    .outputRepo;
  const definitions = Array.from(
    { length: models },
    () => createDefinitionId(crypto.randomUUID()),
  );
  const dirs = new Set<string>();
  for (let i = 0; i < size; i++) {
    const startedAt = new Date(
      now -
        (i < size * inWindow ? Math.random() * 6 : 8 + Math.random() * 300) *
          DAY_MS,
    );
    const method = `m${(i >> 5) % 5}`;
    const output = ModelOutput.create({
      definitionId: definitions[i % definitions.length],
      methodName: method,
      status: "succeeded",
      startedAt,
      completedAt: new Date(startedAt.getTime() + 1500),
      durationMs: 1500,
      provenance: {
        definitionHash: "h",
        modelVersion: "1",
        triggeredBy: "workflow",
        workflowId: crypto.randomUUID(),
        workflowRunId: crypto.randomUUID(),
        stepName: "step",
      },
    });
    const path = repo.getPath(types[i % typeCount], method, output);
    if (!dirs.has(dirname(path))) {
      await ensureDir(dirname(path));
      dirs.add(dirname(path));
    }
    await Deno.writeTextFile(
      path,
      stringifyYaml(JSON.parse(JSON.stringify(output.toData()))),
    );
    const mtime = fresh ? new Date(now) : new Date(startedAt.getTime() + 1500);
    await Deno.utime(path, mtime, mtime);
  }
  // The first model's outputs are every one at an index `models` divides,
  // so all of its type `typeCount` divides too: the first.
  return { repo, definitionId: definitions[0], type: types[0] };
}

const ops = new Map<string, { stats: number; reads: number; runs: number }>();
const stat = Deno.stat;
const readTextFile = Deno.readTextFile;
let counting: { stats: number; reads: number; runs: number } | undefined;
(Deno as { stat: typeof Deno.stat }).stat = (path) => {
  if (counting) counting.stats++;
  return stat(path);
};
(Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = (
  path,
  options,
) => {
  if (counting) counting.reads++;
  return readTextFile(path, options);
};

/** Holds the event loop as other in-flight requests would, until stopped. */
function contend(): () => Promise<void> {
  let running = true;
  const contenders = Array.from({ length: CONTENDERS }, async () => {
    while (running) {
      await stat(root);
      const until = performance.now() + CONTENTION_MS;
      while (performance.now() < until) {
        // Busy: another request's synchronous work.
      }
    }
  });
  return async () => {
    running = false;
    await Promise.all(contenders);
  };
}

async function scan(
  label: string,
  read: () => Promise<unknown>,
  contended: boolean,
): Promise<void> {
  counting = ops.get(label) ?? { stats: 0, reads: 0, runs: 0 };
  ops.set(label, counting);
  counting.runs++;
  const stop = contended ? contend() : undefined;
  try {
    await read();
  } finally {
    counting = undefined;
    await stop?.();
  }
}

for (const size of SIZES) {
  const wholeGroup = `${size} outputs, whole window`;
  const records = await seed(size, false, 200, types.length, 1);
  const warm = await seed(size, false, 200, types.length, 1, true);
  // The first read fills the summaries of what it reads.
  await warm.repo.findAllGlobalSince(cutoff);
  for (
    const [name, { repo }, baseline, n] of [
      ["records", records, true, 3],
      ["warm summaries", warm, false, 10],
    ] as const
  ) {
    const label = `${wholeGroup}: ${name}`;
    Deno.bench({
      name: label,
      group: wholeGroup,
      baseline,
      n,
      warmup: 1,
      async fn() {
        await scan(label, () => repo.findAllGlobalSince(cutoff), false);
      },
    });
  }
  const warmHistory = await seed(
    size,
    false,
    200,
    types.length,
    IN_WINDOW,
    true,
  );
  await warmHistory.repo.findAllGlobalSince(cutoff);
  const settled = await seed(size, false);
  const fresh = await seed(size, true);
  const busy = await seed(size, false, 2, 1);
  const group = `${size} outputs`;
  for (
    const [name, { repo }, contended, n] of [
      ["mtimes at completion", settled, false, 10],
      ["every mtime fresh", fresh, false, 10],
      ["every mtime fresh, contended loop", fresh, true, 3],
    ] as const
  ) {
    const label = `${group}: ${name}`;
    Deno.bench({
      name: label,
      group,
      baseline: !contended && repo === settled.repo,
      n,
      warmup: 1,
      async fn() {
        await scan(label, () => repo.findAllGlobalSince(cutoff), contended);
      },
    });
  }
  const historyGroup = `${size} outputs, one model's history`;
  for (
    const [name, { repo, definitionId, type }, contended, n] of [
      ["spread", settled, false, 10],
      ["spread, contended loop", settled, true, 3],
      ["spread, warm summaries", warmHistory, false, 10],
      ["busy", busy, false, 10],
      ["busy, contended loop", busy, true, 3],
    ] as const
  ) {
    const label = `${historyGroup}: ${name}`;
    Deno.bench({
      name: label,
      group: historyGroup,
      baseline: !contended && repo === settled.repo,
      n,
      warmup: 1,
      async fn() {
        await scan(
          label,
          () =>
            repo.findHistoryByDefinition(type, definitionId, { since: cutoff }),
          contended,
        );
      },
    });
  }
}

globalThis.addEventListener("unload", () => {
  for (const [label, { stats, reads, runs }] of ops) {
    console.log(
      `${label}: ${(stats / runs).toFixed(0)} stats, ${
        (reads / runs).toFixed(0)
      } reads per iteration`,
    );
  }
  Deno.removeSync(root, { recursive: true });
});
