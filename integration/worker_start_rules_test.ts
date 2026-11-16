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

import { assert } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { walk } from "@std/fs";
import { assertPinnedSet, toPosixPath } from "./arch_fitness_helpers.ts";

const INTEGRATION = dirname(fromFileUrl(import.meta.url));
const HELPER = "graph_worker.ts";

async function integrationSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const entry of walk(INTEGRATION, { exts: [".ts"] })) {
    if (!entry.isFile) continue;
    const rel = toPosixPath(relative(INTEGRATION, entry.path));
    sources.set(rel, await Deno.readTextFile(entry.path));
  }
  return sources;
}

Deno.test("worker starts: every test Worker starts through startLoadedWorker", async () => {
  const direct = [...(await integrationSources())]
    .filter(([rel, source]) =>
      rel !== HELPER && rel !== "worker_start_rules_test.ts" &&
      /\bnew Worker\(/.test(source)
    )
    .map(([rel]) => rel);
  assertPinnedSet(
    direct,
    [],
    "new Worker( outside graph_worker.ts",
    "Start the Worker with startLoadedWorker from graph_worker.ts: a bare " +
      "start that stalls loading its module graph is never retried.",
  );
});

Deno.test("worker starts: every script startLoadedWorker starts posts loaded", async () => {
  const sources = await integrationSources();
  const started = new Set<string>();
  const start = /startLoadedWorker(?:<[^>]*>)?\(\s*new URL\(\s*"\.\/([^"?]+)"/g;
  for (const [rel, source] of sources) {
    for (const match of source.matchAll(start)) {
      started.add(toPosixPath(join(dirname(rel), match[1])));
    }
  }
  assert(started.size > 0, "no startLoadedWorker call found");
  const silent = [...started].filter((script) => {
    const source = sources.get(script);
    return source === undefined ||
      !/postMessage\(\s*(LOADED|\{\s*kind:\s*"loaded")/.test(source);
  });
  assertPinnedSet(
    silent,
    [],
    "Worker scripts that never post loaded",
    'Post LOADED (or { kind: "loaded" }) at top level once the script\'s ' +
      "imports have loaded, before anything that outlives the Worker.",
  );
});
