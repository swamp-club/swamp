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

import { SENSITIVE_FORMAT_VERSION } from "../../domain/secrets/persisted_sensitive_form.ts";
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { modelRegistry } from "../../domain/models/model.ts";
import { YamlEvaluatedDefinitionRepository } from "./yaml_evaluated_definition_repository.ts";
import {
  Definition,
  type DefinitionId,
} from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { UserError } from "../../domain/errors.ts";
import {
  keyPath,
  ProvenanceMap,
} from "../../domain/expressions/provenance_map.ts";
import {
  captureUnreadableWarnings,
  fakeUnreadableLookup,
} from "./unreadable_records_test_helpers.ts";

const testType = ModelType.create("test/model");

function toCleanYaml(data: Record<string, unknown>): string {
  return stringifyYaml(JSON.parse(JSON.stringify(data)));
}

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-yaml-evaluated-definition-",
  });
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

Deno.test(
  "YamlEvaluatedDefinitionRepository invokes markDirty with relPath on mutations",
  async () => {
    await withTempDir(async (dir) => {
      const calls: Array<string | undefined> = [];
      const markDirty = (relPath?: string) => {
        calls.push(relPath);
        return Promise.resolve();
      };
      const repo = new YamlEvaluatedDefinitionRepository(
        dir,
        undefined,
        markDirty,
      );

      const definition = Definition.create({
        type: testType.normalized,
        typeVersion: "1",
        name: "test-def",
      });

      // save → per-definition yaml path (name-based for kebab-case names)
      await repo.save(testType, definition, undefined);
      assertEquals(calls.length, 1);
      const savedPath = repo.getPath(testType, definition.id);
      assertEquals(calls[0], savedPath);

      // delete → notifies with the resolved path
      await repo.delete(testType, definition.id);
      assertEquals(calls.length, 2);

      // Reads do not notify.
      await repo.findAll(testType);
      await repo.findById(testType, definition.id);
      assertEquals(calls.length, 2);

      // clearAll → baseDir path (whole evaluated-definitions tree removed)
      await repo.save(testType, definition, undefined);
      assertEquals(calls.length, 3);
      await repo.clearAll();
      assertEquals(calls.length, 4);
      assertEquals(
        calls[3],
        join(dir, ".swamp", "definitions-evaluated"),
      );
    });
  },
);

Deno.test("YamlEvaluatedDefinitionRepository.save writes name-based filename", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "my-eval-def",
    });

    await repo.save(testType, definition, undefined);

    // File should be at {name}.yaml
    const path = repo.getPath(testType, definition.id);
    assertStringIncludes(path, "my-eval-def.yaml");

    // findById should return it
    const loaded = await repo.findById(testType, definition.id);
    assertNotEquals(loaded, null);
    assertEquals(loaded!.name, "my-eval-def");
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.save migrates UUID file to name-based", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "migrate-eval",
    });

    // Manually write a UUID-named file (simulating legacy)
    const typeDir = join(
      dir,
      ".swamp",
      "definitions-evaluated",
      testType.toDirectoryPath(),
    );
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${definition.id}.yaml`);
    const data = definition.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(uuidPath, toCleanYaml(data));

    // Load and re-save — should migrate
    const loaded = await repo.findById(testType, definition.id);
    assertNotEquals(loaded, null);
    await repo.save(testType, loaded!, undefined);

    // Name-based file should exist
    const namePath = join(typeDir, "migrate-eval.yaml");
    const stat = await Deno.stat(namePath);
    assertEquals(stat.isFile, true);

    // UUID file should be gone
    try {
      await Deno.stat(uuidPath);
      assertEquals(true, false, "UUID file should have been removed");
    } catch (error) {
      assertEquals(error instanceof Deno.errors.NotFound, true);
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.findByName fast path works", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "find-by-name",
    });

    await repo.save(testType, definition, undefined);

    const found = await repo.findByName(testType, "find-by-name");
    assertNotEquals(found, null);
    assertEquals(found!.id, definition.id);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.findByName falls through when file name diverges", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "actual-name",
    });

    await repo.save(testType, definition, undefined);

    // Rename file on disk but keep content name as "actual-name"
    const typeDir = join(
      dir,
      ".swamp",
      "definitions-evaluated",
      testType.toDirectoryPath(),
    );
    const namePath = join(typeDir, "actual-name.yaml");
    const wrongPath = join(typeDir, "wrong-name.yaml");
    await Deno.rename(namePath, wrongPath);

    // findByName("wrong-name") should fall through since content says "actual-name"
    const found = await repo.findByName(testType, "wrong-name");
    assertEquals(found, null);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.delete handles name-based files on cold cache", async () => {
  await withTempDir(async (dir) => {
    // Save with one repo instance
    const repo1 = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "cold-eval-delete",
    });
    await repo1.save(testType, definition, undefined);

    // Delete with a fresh instance (cold cache)
    const repo2 = new YamlEvaluatedDefinitionRepository(dir);
    await repo2.delete(testType, definition.id);

    assertEquals(await repo2.findById(testType, definition.id), null);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository.clearAll also clears path cache", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);

    const definition = Definition.create({
      type: testType.normalized,
      typeVersion: "1",
      name: "clear-cache",
    });

    await repo.save(testType, definition, undefined);
    assertNotEquals(await repo.findById(testType, definition.id), null);

    await repo.clearAll();
    assertEquals(await repo.findById(testType, definition.id), null);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: reloads provenance from name and UUID caches", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({ name: "provenance" });
    const authoredExpressions = new Set(["${{ env.HOME }}"]);
    await repo.save(testType, definition, undefined, authoredExpressions);
    const path = repo.getPath(testType, definition.id);
    const legacyPath = join(
      dir,
      ".swamp",
      "definitions-evaluated",
      testType.toDirectoryPath(),
      `${definition.id}.yaml`,
    );
    for (const legacy of [false, true]) {
      if (legacy) await Deno.rename(path, legacyPath);
      const fresh = new YamlEvaluatedDefinitionRepository(dir);
      const cached = await fresh.findByNameWithProvenance(
        testType,
        definition.name,
      );
      assertEquals(cached?.authoredExpressions, authoredExpressions);
      assertEquals(
        cached?.definition.toData(),
        (await fresh.findByName(testType, definition.name))?.toData(),
      );
      assertEquals(
        Object.hasOwn(cached!.definition.toData(), "authoredExpressions"),
        false,
      );
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: replacing a cache replaces its provenance", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({ name: "provenance" });
    await repo.save(
      testType,
      definition,
      undefined,
      new Set(["${{ env.OLD }}"]),
    );
    for (
      const authored of [
        new Set(["${{ env.NEW }}"]),
        new Set<string>(),
        undefined,
      ]
    ) {
      await repo.save(testType, definition, undefined, authored);
      const cached = await new YamlEvaluatedDefinitionRepository(dir)
        .findByNameWithProvenance(testType, definition.name);
      assertEquals(cached?.authoredExpressions, authored ?? new Set());
      assertEquals(cached?.deferredExpressions, []);
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: rejects malformed provenance", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({ name: "provenance" });
    await repo.save(testType, definition, undefined);
    const path = repo.getPath(testType, definition.id);
    for (
      const authoredExpressions of [null, "${{ env.HOME }}", {}, [42], [
        "${{ env.HOME }}",
        false,
      ]]
    ) {
      await Deno.writeTextFile(
        path,
        toCleanYaml({ ...definition.toData(), authoredExpressions }),
      );
      await assertRejects(() =>
        new YamlEvaluatedDefinitionRepository(dir).findByNameWithProvenance(
          testType,
          definition.name,
        )
      );
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: persistedProvenance is written beside provenance, both pruned below a masked position, and read back; a malformed one reads as unreadable (swamp-club#3744)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({
      name: "persisted-provenance",
      globalArguments: { creds: "***", note: "Bearer x" },
    });
    // A key of the masked record came from data: it must not survive in
    // either map once the record is the mask.
    const key = "SECRET-KEY-7c1e";
    const provenance = ProvenanceMap.authored()
      .withWholeData(keyPath("globalArguments.creds", key))
      .withRanges("globalArguments.note", [[0, 6]]);
    const persistedProvenance = ProvenanceMap.authored()
      .withWholeData(keyPath("globalArguments.creds", key))
      .withRanges("globalArguments.note", [[7, 8]]);
    await repo.save(
      testType,
      definition,
      provenance,
      undefined,
      undefined,
      [],
      [["globalArguments", "creds"]],
      persistedProvenance,
    );
    const path = repo.getPath(testType, definition.id);
    assertEquals((await Deno.readTextFile(path)).includes(key), false);
    const cached = await new YamlEvaluatedDefinitionRepository(dir)
      .findByNameWithProvenance(testType, definition.name);
    const read = (map: ProvenanceMap | "unreadable" | undefined) =>
      map instanceof ProvenanceMap ? map.toData() : map;
    assertEquals(read(cached?.provenance), {
      whole: ["globalArguments.creds"],
      ranges: { "globalArguments.note": [[0, 6]] },
    });
    assertEquals(read(cached?.persistedProvenance), {
      whole: ["globalArguments.creds"],
      ranges: { "globalArguments.note": [[7, 8]] },
    });

    // A cache written without it reads back with none.
    await repo.save(testType, definition, undefined);
    assertEquals(
      (await new YamlEvaluatedDefinitionRepository(dir)
        .findByNameWithProvenance(testType, definition.name))
        ?.persistedProvenance,
      undefined,
    );

    await Deno.writeTextFile(
      path,
      toCleanYaml({
        ...definition.toData(),
        persistedProvenance: { whole: 42, ranges: {} },
      }),
    );
    assertEquals(
      (await new YamlEvaluatedDefinitionRepository(dir)
        .findByNameWithProvenance(testType, definition.name))
        ?.persistedProvenance,
      "unreadable",
    );
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: records the source typeVersion verbatim", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const type = ModelType.create("test/evaluated-stale");
    const definition = Definition.create({
      name: "stale-evaluated",
      type: type.normalized,
      typeVersion: "2026.01.01.1",
      globalArguments: { project: "demo" },
    });

    await repo.save(type, definition, undefined);

    // Evaluated definitions are derived data replayed under --last-evaluated.
    // Restamping here would reintroduce the staleness masking that was fixed
    // in the source repository (swamp-club#900).
    const reloaded = await repo.findByName(type, "stale-evaluated");
    assertEquals(reloaded?.typeVersion, "2026.01.01.1");
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: records the sensitive format and written references (swamp-club#2171)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    const definition = Definition.create({
      name: "ref-definition",
      globalArguments: { tok: "${{ vault.get('prod', 'api-token') }}" },
    });
    const reference = {
      path: ["globalArguments", "tok"],
      occurrence: 0,
      vaultName: "prod",
      key: "api-token",
      encoding: "raw" as const,
      dataOrigin: true,
    };
    await repo.save(type, definition, undefined, new Set(), [], [reference]);
    const cached = await repo.findByNameWithProvenance(type, "ref-definition");
    assertEquals(cached?.sensitiveFormat, SENSITIVE_FORMAT_VERSION);
    assertEquals(cached?.writtenReferences, [reference]);
    assertEquals(
      cached?.definition.globalArguments.tok,
      "${{ vault.get('prod', 'api-token') }}",
    );
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: a cache written before the format has no marker (swamp-club#2171)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    const definition = Definition.create({ name: "old-definition" });
    const typeDir = join(
      dir,
      ".swamp",
      "definitions-evaluated",
      "command",
      "shell",
    );
    await ensureDir(typeDir);
    await Deno.writeTextFile(
      join(typeDir, "old-definition.yaml"),
      toCleanYaml({ ...definition.toData(), type: "command/shell" }),
    );
    const cached = await repo.findByNameWithProvenance(type, "old-definition");
    assertEquals(cached?.sensitiveFormat, undefined);
    assertEquals(cached?.writtenReferences, []);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: an evaluated definition the lookup names unreadable fails findByName and findById; an absent one is not found (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const type = ModelType.create("test/evaluated");
    const lost = Definition.create({ name: "lost" });
    const baseDir = join(dir, ".swamp", "definitions-evaluated");
    const unreadable = new Set([
      join(baseDir, type.toDirectoryPath(), "lost.yaml"),
      join(baseDir, type.toDirectoryPath(), `${lost.id}.yaml`),
    ]);
    const repo = new YamlEvaluatedDefinitionRepository(
      dir,
      baseDir,
      undefined,
      (path) =>
        Promise.resolve(
          unreadable.has(path)
            ? new UserError("unreadable", "datastore_v3_record_unreadable")
            : undefined,
        ),
    );
    await assertRejects(
      () => repo.findByNameWithProvenance(type, "lost"),
      UserError,
      "unreadable",
    );
    await assertRejects(
      () => repo.findById(type, lost.id as DefinitionId),
      UserError,
      "unreadable",
    );
    assertEquals(await repo.findByName(type, "other"), null);
    assertEquals(
      await repo.findById(
        type,
        Definition.create({ name: "other" }).id as DefinitionId,
      ),
      null,
    );
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: findByNameGlobal of a name the lookup names unreadable under any type fails with its error; listings warn naming it (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const baseDir = join(dir, ".swamp", "definitions-evaluated");
    const type = ModelType.create("test/evaluated-listed");
    // A type with no directory left in this checkout.
    const lost = join(baseDir, "test", "gone", "lost.yaml");
    const listedLost = join(baseDir, type.toDirectoryPath(), "lost2.yaml");
    const { lookup, errors } = fakeUnreadableLookup([lost, listedLost]);
    const repo = new YamlEvaluatedDefinitionRepository(
      dir,
      baseDir,
      undefined,
      lookup,
    );
    const kept = Definition.create({ name: "kept" });
    await repo.save(type, kept, undefined);
    assertEquals(
      await assertRejects(() => repo.findByNameGlobal("lost")),
      errors.get(lost),
    );
    assertEquals((await repo.findByNameGlobal("kept"))?.definition.id, kept.id);
    assertEquals(await repo.findByNameGlobal("other"), null);
    const warnings = await captureUnreadableWarnings(async () => {
      assertEquals((await repo.findAll(type)).map((d) => d.id), [kept.id]);
      assertEquals(
        (await repo.findAllGlobal()).map((e) => e.definition.id),
        [kept.id],
      );
    });
    assertEquals(warnings.length, 2, warnings.join("\n"));
    assertStringIncludes(warnings[0], listedLost);
    assertStringIncludes(warnings[1], lost);
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: save refuses a plaintext literal under a sensitive argument of a registered type and leaves no file; the mask and a vault reference are written (swamp-club#3681)", async () => {
  await withTempDir(async (dir) => {
    const type = ModelType.create(
      `test/evaluated-sensitive-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type,
      version: "2026.01.01.1",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }).optional(),
      }),
      methods: {
        run: {
          description: "runs",
          arguments: z.object({
            token: z.string().meta({ sensitive: true }).optional(),
          }),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });
    try {
      const repo = new YamlEvaluatedDefinitionRepository(dir);
      const value = "REPRO-SECRET-7c1e";
      const leaky = Definition.create({
        name: "leaky",
        globalArguments: { apiKey: value },
        methods: { run: { arguments: { token: value } } },
      });
      const error = await assertRejects(
        () => repo.save(type, leaky, undefined),
        UserError,
      );
      assertEquals(error.code, "plaintext_sensitive_evaluated_arg");
      assertStringIncludes(
        error.message,
        `"leaky" holds a plaintext value for the sensitive arguments 'globalArguments.apiKey', 'methods.run.arguments.token'`,
      );
      assertEquals(error.message.includes(value), false);
      assertEquals(await repo.findByName(type, "leaky"), null);

      const ref = "${{ vault.get('prod', 'api-key') }}";
      const safe = Definition.create({
        name: "safe",
        globalArguments: { apiKey: "***" },
        methods: { run: { arguments: { token: ref } } },
      });
      await repo.save(type, safe, undefined, undefined, undefined, [], [[
        "globalArguments",
        "apiKey",
      ]]);
      const read = await repo.findByNameWithProvenance(type, "safe");
      assertEquals(read?.definition.globalArguments, { apiKey: "***" });
      assertEquals(read?.definition.getMethodArguments("run"), { token: ref });
      // The masked position is recorded with the file and read back.
      assertEquals(read?.maskedPaths, [["globalArguments", "apiKey"]]);

      // An author-written expression joined to text is not a value yet, so
      // the guard lets it through with no written reference.
      const pending = Definition.create({
        name: "pending",
        methods: { run: { arguments: { token: `Bearer ${ref}` } } },
      });
      await repo.save(type, pending, undefined);
      assertEquals(
        (await repo.findByName(type, "pending"))?.getMethodArguments("run"),
        { token: `Bearer ${ref}` },
      );

      // A written reference vouches for the text joined to it.
      const joined = Definition.create({
        name: "joined",
        globalArguments: { apiKey: `Bearer ${ref}` },
      });
      await repo.save(type, joined, undefined, undefined, undefined, [{
        path: ["globalArguments", "apiKey"],
        occurrence: 0,
        vaultName: "prod",
        key: "api-key",
        encoding: "raw",
        dataOrigin: false,
      }]);
      assertEquals((await repo.findByName(type, "joined"))?.globalArguments, {
        apiKey: `Bearer ${ref}`,
      });
      // Unless the text beside it is data: a reference vouches only for
      // itself, so data joined to it is refused, whether the ranges come
      // from the raw provenance or the persisted text's (swamp-club#3744).
      const prefix = ProvenanceMap.authored().withRanges(
        "globalArguments.apiKey",
        [[0, "Bearer ".length]],
      );
      for (
        const [provenance, persistedProvenance] of [
          [prefix, undefined],
          [undefined, prefix],
        ] as const
      ) {
        const spliced = Definition.create({
          name: "spliced",
          globalArguments: { apiKey: `Bearer ${ref}` },
        });
        await assertRejects(
          () =>
            repo.save(
              type,
              spliced,
              provenance,
              undefined,
              undefined,
              [{
                path: ["globalArguments", "apiKey"],
                occurrence: 0,
                vaultName: "prod",
                key: "api-key",
                encoding: "raw",
                dataOrigin: false,
              }],
              [],
              persistedProvenance,
            ),
          UserError,
        );
        assertEquals(await repo.findByName(type, "spliced"), null);
      }
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("YamlEvaluatedDefinitionRepository: save of an unregistered type has no schemas to check against and writes (swamp-club#3681)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlEvaluatedDefinitionRepository(dir);
    const definition = Definition.create({
      name: "unknown-type",
      globalArguments: { apiKey: "any-value" },
    });
    await repo.save(testType, definition, undefined);
    const read = await repo.findByNameWithProvenance(testType, "unknown-type");
    assertEquals(read?.definition.globalArguments, { apiKey: "any-value" });
    // A cache written with no masked positions reads back with none.
    assertEquals(read?.maskedPaths, []);
  });
});
