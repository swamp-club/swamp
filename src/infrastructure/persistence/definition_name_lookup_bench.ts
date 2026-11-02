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

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import {
  type DefinitionFileSource,
  DefinitionIdIndex,
} from "./definition_id_index.ts";
import { createRepositoryContext } from "./repository_factory.ts";

const STORED = 15_000;
const CONCURRENT = 36;
const TYPE = "test/runner";

const repoDir = await Deno.makeTempDir({ prefix: "swamp_name_lookup_bench_" });
const ctx = createRepositoryContext({ repoDir, enableIndexing: false });
const repo = ctx.definitionRepo;
const runnerDir = join(ctx.autoDefinitionsDir, "test", "runner");
await ensureDir(runnerDir);
await ensureDir(join(repoDir, "models"));
const storedIds: DefinitionId[] = [];
for (let i = 0; i < STORED; i++) {
  const id = crypto.randomUUID();
  storedIds.push(id as DefinitionId);
  await Deno.writeTextFile(
    join(runnerDir, `stored-${i}.yaml`),
    `type: ${TYPE}\nid: ${id}\nname: stored-${i}\nversion: 1\ntags: {}\nglobalArguments: {}\nmethods: {}\n`,
  );
}
// wait past the index's racy window so the stored files count as settled, as
// they do on a server
await new Promise((resolve) => setTimeout(resolve, 2_500));

const reads = new Map<string, { files: number; iterations: number }>();

function countingIndex(label: string): DefinitionIdIndex {
  const source: DefinitionFileSource = {
    definitionRoots: () => repo.definitionRoots(),
    readDefinitionFile: (path, segments, isSymlink) => {
      const entry = reads.get(label)!;
      entry.files++;
      return repo.readDefinitionFile(path, segments, isSymlink);
    },
  };
  return new DefinitionIdIndex(source);
}

function iteration(label: string): void {
  const entry = reads.get(label) ?? { files: 0, iterations: 0 };
  entry.iterations++;
  reads.set(label, entry);
}

const warm = countingIndex("warm misses");
reads.set("warm misses", { files: 0, iterations: 0 });
await warm.findByName("warm-up");
reads.set("warm misses", { files: 0, iterations: 0 });

const burst = countingIndex("after a burst");
reads.set("after a burst", { files: 0, iterations: 0 });
await burst.findByName("warm-up");
reads.set("after a burst", { files: 0, iterations: 0 });
let burstRound = 0;

let walkRound = 0;
Deno.bench({
  name: "walk: one miss, no index (before swamp-club#4037)",
  group: "miss",
  baseline: true,
  n: 5,
  warmup: 1,
  async fn() {
    await repo.findByNameGlobal(`walk-${walkRound++}`);
  },
});

Deno.bench({
  name: "index: cold build and one miss",
  group: "miss",
  n: 5,
  warmup: 1,
  async fn() {
    iteration("cold build");
    await countingIndex("cold build").findByName("missing");
  },
});

let warmRound = 0;
Deno.bench({
  name: `index: ${CONCURRENT} concurrent warm misses`,
  group: "miss",
  async fn() {
    iteration("warm misses");
    const round = warmRound++;
    await Promise.all(
      Array.from(
        { length: CONCURRENT },
        (_, i) => warm.findByName(`warm-${round}-${i}`),
      ),
    );
  },
});

// Deno runs groups in the order first registered, so this runs before the
// burst, whose new files would leave the directory too recent to trust
const ownerLookups = countingIndex("warm owner lookups");
reads.set("warm owner lookups", { files: 0, iterations: 0 });
await ownerLookups.begin();
reads.set("warm owner lookups", { files: 0, iterations: 0 });

Deno.bench({
  name: `index: ${STORED} warm owner lookups, 8 at a time`,
  group: "owners",
  n: 20,
  warmup: 1,
  async fn() {
    iteration("warm owner lookups");
    const view = await ownerLookups.begin();
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < storedIds.length) {
        await view.findAllById(storedIds[next++]);
      }
    }));
  },
});

Deno.bench({
  name:
    `index: ${CONCURRENT} concurrent lookups right after ${CONCURRENT} new definitions`,
  group: "burst",
  n: 20,
  warmup: 1,
  async fn(b) {
    const round = burstRound++;
    for (let i = 0; i < CONCURRENT; i++) {
      const name = `burst-${round}-${i}`;
      await Deno.writeTextFile(
        join(runnerDir, `${name}.yaml`),
        `type: ${TYPE}\nid: ${crypto.randomUUID()}\nname: ${name}\nversion: 1\ntags: {}\nglobalArguments: {}\nmethods: {}\n`,
      );
    }
    iteration("after a burst");
    b.start();
    await Promise.all(
      Array.from(
        { length: CONCURRENT },
        (_, i) => burst.findByName(`burst-${round}-${i}-recheck`),
      ),
    );
    b.end();
  },
});

globalThis.addEventListener("unload", () => {
  for (const [label, { files, iterations }] of reads) {
    if (iterations === 0) continue;
    console.log(
      `${label}: ${(files / iterations).toFixed(1)} files read per iteration`,
    );
  }
  Deno.removeSync(repoDir, { recursive: true });
});
