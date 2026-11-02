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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import {
  Definition,
  type DefinitionId,
} from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../src/domain/models/model_lookup.ts";
import {
  PhaseTally,
  withDiagnosticTally,
} from "../src/domain/diagnostics/diagnostic_phase.ts";
import {
  type DefinitionFileSource,
  DefinitionIdIndex,
} from "../src/infrastructure/persistence/definition_id_index.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

const RUNS = 300;
const shell = ModelType.create("command/shell");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-id-index-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// the index clock runs a minute ahead so files the test writes are settled
function serveWiring(dir: string) {
  const autoDir = join(dir, ".swamp", "auto-definitions");
  const repo = new YamlDefinitionRepository(dir, undefined, undefined, autoDir);
  const writer = new YamlDefinitionRepository(dir, undefined, autoDir, false);
  const counter = { indexReads: 0 };
  const source: DefinitionFileSource = {
    definitionRoots: () => repo.definitionRoots(),
    readDefinitionFile: (path, segments, isSymlink) => {
      counter.indexReads++;
      return repo.readDefinitionFile(path, segments, isSymlink);
    },
  };
  const index = new DefinitionIdIndex(source, {
    now: () => Date.now() + 60_000,
  });
  repo.useNameIndex(index);
  repo.useIdIndex(index);
  return { repo, writer, counter, autoDir };
}

// reads inside the index's own check phase are not counted here
async function filesRead<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const tally = new PhaseTally(true);
  const result = await withDiagnosticTally("step_outputs", tally, fn);
  return [result, tally.attributes()["swamp.diagnostic.files_read"] ?? 0];
}

async function saveRuns(
  writer: YamlDefinitionRepository,
  count: number,
): Promise<Definition[]> {
  const saved: Definition[] = [];
  for (let i = 0; i < count; i++) {
    const definition = Definition.create({
      name: `x-${crypto.randomUUID()}`,
      globalArguments: {},
    });
    await writer.save(shell, definition);
    saved.push(definition);
  }
  return saved;
}

Deno.test("serve definition index: a lookup by id of an auto-definition reads only its own file, however many runs came before", async () => {
  await withTempDir(async (dir) => {
    const { repo, writer, counter } = serveWiring(dir);
    const runs = await saveRuns(writer, RUNS);
    // a cold index reads every file once
    await repo.findById(shell, crypto.randomUUID() as DefinitionId);
    assertEquals(counter.indexReads, RUNS);

    for (const run of [runs[0], runs[RUNS / 2], runs[RUNS - 1]]) {
      const before = counter.indexReads;
      const [found, reads] = await filesRead(() =>
        repo.findById(shell, run.id)
      );
      assertEquals(found?.name, run.name);
      assertEquals(reads, 1);
      assertEquals(counter.indexReads - before, 1);
    }
  });
});

Deno.test("serve definition index: a run's new auto-definition is found by id reading only the new file", async () => {
  await withTempDir(async (dir) => {
    const { repo, writer, counter } = serveWiring(dir);
    await saveRuns(writer, RUNS);
    await repo.findById(shell, crypto.randomUUID() as DefinitionId);

    const before = counter.indexReads;
    const [added] = await saveRuns(writer, 1);
    const found = await repo.findById(shell, added.id);
    assertEquals(found?.name, added.name);
    // the new file when its directory is listed again, then when found
    assertEquals(counter.indexReads - before, 2);
  });
});

Deno.test("serve definition index: global lookups by id, by an authorized name, and of a UUID tried as a name first read only the files that declare it", async () => {
  await withTempDir(async (dir) => {
    const { repo, writer, counter } = serveWiring(dir);
    const runs = await saveRuns(writer, RUNS);
    await repo.findById(shell, crypto.randomUUID() as DefinitionId);
    const target = runs[RUNS - 7];

    const lookups = [
      () => findDefinitionByIdGlobal(repo, target.id),
      () => findDefinitionByIdGlobal(repo, target.id, target.name),
      () => findDefinitionByIdOrName(repo, target.id),
    ];
    for (const lookup of lookups) {
      const before = counter.indexReads;
      const [found, reads] = await filesRead(lookup);
      assertEquals(found?.definition.id, target.id);
      assertEquals(found?.type.normalized, shell.normalized);
      assert(reads <= 2, `read ${reads} files`);
      assert(
        counter.indexReads - before <= 2,
        `the index read ${counter.indexReads - before} files`,
      );
    }
  });
});

Deno.test("serve definition index: a lookup by id of a definition that is gone reads no definition file", async () => {
  await withTempDir(async (dir) => {
    const { repo, writer, counter } = serveWiring(dir);
    await saveRuns(writer, RUNS);
    await repo.findById(shell, crypto.randomUUID() as DefinitionId);

    const before = counter.indexReads;
    const [found, reads] = await filesRead(() =>
      findDefinitionByIdGlobal(repo, crypto.randomUUID())
    );
    assertEquals(found, null);
    assertEquals(reads, 0);
    assertEquals(counter.indexReads, before);
  });
});

Deno.test("serve definition index: without the index, the CLI still finds an auto-definition by id", async () => {
  await withTempDir(async (dir) => {
    const { writer, autoDir } = serveWiring(dir);
    const runs = await saveRuns(writer, 20);
    const cli = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
    );

    assertEquals((await cli.findById(shell, runs[11].id))?.name, runs[11].name);
    assertEquals(
      (await findDefinitionByIdGlobal(cli, runs[11].id))?.definition.name,
      runs[11].name,
    );
  });
});
