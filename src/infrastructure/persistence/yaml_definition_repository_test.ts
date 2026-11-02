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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import {
  DefinitionIdIndex,
  type DefinitionIdLookup,
  type DefinitionNameIndex,
} from "./definition_id_index.ts";
import {
  Definition,
  type DefinitionId,
} from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { defineModel, modelRegistry } from "../../domain/models/model.ts";
import { UserError } from "../../domain/errors.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { assertPathEquals } from "./path_test_helpers.ts";
import {
  pathExists,
  recordingUnitOfWork,
} from "./test_helpers/staged_change_helpers.ts";
import { runInUnitOfWork } from "./unit_of_work_scope.ts";
import {
  captureUnreadableWarnings,
  fakeUnreadableLookup,
} from "./unreadable_records_test_helpers.ts";
import {
  observeDiagnosticPhase,
  PhaseTally,
  withDiagnosticArea,
  withDiagnosticAttributes,
  withDiagnosticTally,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  type ReadableSpan,
  withObservedSpans,
} from "../tracing/span_test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function createTestDefinition(name: string): Definition {
  return Definition.create({
    name,
    globalArguments: { key: "value" },
  });
}

const testType = ModelType.create("test/example");

function toCleanYaml(data: Record<string, unknown>): string {
  return stringifyYaml(JSON.parse(JSON.stringify(data)));
}

Deno.test("YamlDefinitionRepository.save and findById roundtrip", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("test-def");

    await repo.save(testType, definition);
    const loaded = await repo.findById(testType, definition.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.id, definition.id);
    assertEquals(loaded!.name, definition.name);
  });
});

Deno.test("YamlDefinitionRepository.findById does not answer for another type from its id cache", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("typed-def");
    const otherType = ModelType.create("test/other-type");

    await repo.save(testType, definition);
    await repo.findById(testType, definition.id);

    assertEquals(await repo.findById(otherType, definition.id), null);
    assertEquals(
      (await repo.findById(testType, definition.id))?.id,
      definition.id,
    );
  });
});

Deno.test("YamlDefinitionRepository.delete leaves a same-id definition of another type alone", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("kept-def");
    const otherType = ModelType.create("test/other-type");

    await repo.save(testType, definition);
    await repo.findById(testType, definition.id);
    await repo.delete(otherType, definition.id);

    assertEquals(
      (await repo.findById(testType, definition.id))?.id,
      definition.id,
    );
  });
});

Deno.test("YamlDefinitionRepository.findById never returns a definition named with the requested id", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const target = createTestDefinition("target-def");
    // Named with target's id, so its file sits at target's id-named path.
    const impostor = createTestDefinition(target.id);
    await repo.save(testType, target);
    await repo.save(testType, impostor);

    const fresh = new YamlDefinitionRepository(dir);
    assertEquals((await fresh.findById(testType, target.id))?.id, target.id);
  });
});

Deno.test("YamlDefinitionRepository.delete leaves a definition named with the deleted id alone", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const target = createTestDefinition("target-def");
    const impostor = createTestDefinition(target.id);
    await repo.save(testType, target);
    await repo.save(testType, impostor);

    await new YamlDefinitionRepository(dir).delete(testType, target.id);

    const fresh = new YamlDefinitionRepository(dir);
    assertEquals(await fresh.findById(testType, target.id), null);
    assertEquals(
      (await fresh.findById(testType, impostor.id))?.name,
      target.id,
    );
  });
});

Deno.test("YamlDefinitionRepository.findById and delete find a misfiled definition under the type it declares", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const declared = ModelType.create("test/declared-type");
    const definition = createTestDefinition("misfiled-def");
    await repo.save(testType, definition);
    // Filed under testType's directory but declaring another type, as a
    // hand-edited file can be.
    const path = repo.getPath(testType, definition.id);
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)).replace(
        `type: ${testType.normalized}`,
        `type: ${declared.normalized}`,
      ),
    );
    await repo.findAll(testType);

    assertEquals(
      (await repo.findById(declared, definition.id))?.id,
      definition.id,
    );
    assertEquals(await repo.findById(testType, definition.id), null);

    await repo.delete(declared, definition.id);
    assertEquals(await new YamlDefinitionRepository(dir).findAll(testType), []);
  });
});

Deno.test("YamlDefinitionRepository.delete with a name leaves another definition sharing the id", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const prod = createTestDefinition("prod-def");
    await repo.save(testType, prod);
    const path = repo.getPath(testType, prod.id);
    await Deno.writeTextFile(
      join(dir, "models", testType.toDirectoryPath(), "safe-def.yaml"),
      (await Deno.readTextFile(path)).replace(
        "name: prod-def",
        "name: safe-def",
      ),
    );
    await repo.findByNameGlobal("safe-def");
    await repo.findByNameGlobal("prod-def");

    await repo.delete(testType, prod.id, "safe-def");

    const fresh = new YamlDefinitionRepository(dir);
    assertEquals(await fresh.findByNameGlobal("safe-def"), null);
    assertEquals(
      (await fresh.findByNameGlobal("prod-def"))?.definition.id,
      prod.id,
    );
  });
});

Deno.test("YamlDefinitionRepository.findAll skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await Deno.writeTextFile(
      join(typeDir, "broken.yaml"),
      "this: is: not: valid: yaml: [",
    );

    const results = await repo.findAll(testType);

    assertEquals(results.length, 1);
    assertEquals(results[0].name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await Deno.writeTextFile(
      join(typeDir, "broken.yaml"),
      "not valid yaml content {{{",
    );

    const results = await repo.findAllGlobal();

    assertEquals(results.length, 1);
    assertEquals(results[0].definition.name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await Deno.writeTextFile(
      join(typeDir, "broken.yaml"),
      "not valid yaml content {{{",
    );

    const result = await repo.findByNameGlobal("good-def");
    assertNotEquals(result, null);
    assertEquals(result!.definition.name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal skips schema-invalid YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");

    await repo.save(testType, goodDef);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const invalidData = { description: "no name or id field" };
    await Deno.writeTextFile(
      join(typeDir, "invalid-schema.yaml"),
      stringifyYaml(invalidData),
    );

    const results = await repo.findAllGlobal();

    assertEquals(results.length, 1);
    assertEquals(results[0].definition.name, "good-def");
  });
});

Deno.test("YamlDefinitionRepository.findAll returns empty for no definitions", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const all = await repo.findAll(testType);
    assertEquals(all, []);
  });
});

Deno.test("YamlDefinitionRepository.delete removes definition", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("to-delete");

    await repo.save(testType, definition);
    assertEquals((await repo.findById(testType, definition.id)) !== null, true);

    await repo.delete(testType, definition.id);
    assertEquals(await repo.findById(testType, definition.id), null);
  });
});

Deno.test("YamlDefinitionRepository.findAll discovers symlinked YAML files targeting outside models/", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("real-def");

    await repo.save(testType, definition);

    const secondDef = createTestDefinition("legacy-def");
    const legacyDir = join(
      dir,
      ".swamp",
      "definitions",
      testType.toDirectoryPath(),
    );
    await ensureDir(legacyDir);
    const realFile = join(legacyDir, `${secondDef.id}.yaml`);
    const data = secondDef.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await Deno.symlink(realFile, join(typeDir, `${secondDef.id}.yaml`), {
      type: "file",
    });

    const results = await repo.findAll(testType);
    assertEquals(results.length, 2);
    const names = results.map((d) => d.name).sort();
    assertEquals(names, ["legacy-def", "real-def"]);
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal discovers symlinked YAML files targeting outside models/", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("real-def");
    await repo.save(testType, definition);

    const symDef = createTestDefinition("ext-def");
    const extDir = join(
      dir,
      "extensions",
      "models",
      testType.toDirectoryPath(),
    );
    await ensureDir(extDir);
    const realFile = join(extDir, `${symDef.id}.yaml`);
    const data = symDef.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await Deno.symlink(realFile, join(typeDir, `${symDef.id}.yaml`), {
      type: "file",
    });

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 2);
    const names = results.map((r) => r.definition.name).sort();
    assertEquals(names, ["ext-def", "real-def"]);
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal discovers symlinked YAML files targeting outside models/", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const symDef = createTestDefinition("ext-find");
    const extDir = join(
      dir,
      "extensions",
      "models",
      testType.toDirectoryPath(),
    );
    await ensureDir(extDir);
    const realFile = join(extDir, `${symDef.id}.yaml`);
    const data = symDef.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    await Deno.symlink(realFile, join(typeDir, `${symDef.id}.yaml`), {
      type: "file",
    });

    const result = await repo.findByNameGlobal("ext-find");
    assertNotEquals(result, null);
    assertEquals(result!.definition.name, "ext-find");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal uses YAML type field over path", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const def = Definition.create({
      name: "typed-def",
      type: "@smith/kibana-dev",
      globalArguments: { key: "value" },
    });

    const typeDir = join(dir, "models", "kibana");
    await ensureDir(typeDir);
    const data = def.toData();
    data.type = "@smith/kibana-dev";
    await Deno.writeTextFile(
      join(typeDir, `${def.id}.yaml`),
      toCleanYaml(data),
    );

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 1);
    assertEquals(results[0].type.normalized, "@smith/kibana-dev");
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal uses YAML type field over path", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const def = Definition.create({
      name: "typed-find",
      type: "@smith/kibana-dev",
      globalArguments: { key: "value" },
    });

    const typeDir = join(dir, "models", "kibana");
    await ensureDir(typeDir);
    const data = def.toData();
    data.type = "@smith/kibana-dev";
    await Deno.writeTextFile(
      join(typeDir, `${def.id}.yaml`),
      toCleanYaml(data),
    );

    const result = await repo.findByNameGlobal("typed-find");
    assertNotEquals(result, null);
    assertEquals(result!.type.normalized, "@smith/kibana-dev");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal falls back to path-based type when YAML type is missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const def = Definition.create({
      name: "no-type-def",
      globalArguments: { key: "value" },
    });

    const typeDir = join(dir, "models", "test", "example");
    await ensureDir(typeDir);
    const data = def.toData();
    delete data.type;
    await Deno.writeTextFile(
      join(typeDir, `${def.id}.yaml`),
      toCleanYaml(data),
    );

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 1);
    assertEquals(results[0].type.normalized, "test/example");
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal resolves symlinked extension with scoped type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    // an extension definition lives in extensions/models/ and is symlinked into
    // models/; its YAML type is @smith/kibana-dev but the directory path is
    // just kibana-dev
    const def = Definition.create({
      name: "my-kibana",
      type: "@smith/kibana-dev",
      globalArguments: { host: "localhost" },
    });

    const extDir = join(dir, "extensions", "models", "kibana-dev");
    await ensureDir(extDir);
    const realFile = join(extDir, `${def.id}.yaml`);
    const data = def.toData();
    data.type = "@smith/kibana-dev";
    await Deno.writeTextFile(realFile, toCleanYaml(data));

    const typeDir = join(dir, "models", "kibana-dev");
    await ensureDir(typeDir);
    await Deno.symlink(realFile, join(typeDir, `${def.id}.yaml`), {
      type: "file",
    });

    const results = await repo.findAllGlobal();
    assertEquals(results.length, 1);
    assertEquals(results[0].type.normalized, "@smith/kibana-dev");
    assertEquals(results[0].definition.name, "my-kibana");
  });
});

Deno.test("YamlDefinitionRepository.findAll rejects symlink pointing outside repo", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("good-def");
    await repo.save(testType, definition);

    const outsideDir = await Deno.makeTempDir();
    try {
      const outsideFile = join(outsideDir, "evil.yaml");
      const evilData = {
        id: crypto.randomUUID(),
        name: "evil-def",
        version: 1,
        tags: {},
        globalArguments: {},
        methods: {},
      };
      await Deno.writeTextFile(outsideFile, stringifyYaml(evilData));

      const typeDir = join(dir, "models", testType.toDirectoryPath());
      await Deno.symlink(outsideFile, join(typeDir, "evil.yaml"), {
        type: "file",
      });

      const results = await repo.findAll(testType);
      assertEquals(results.length, 1);
      assertEquals(results[0].name, "good-def");
    } finally {
      await Deno.remove(outsideDir, { recursive: true });
    }
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal finds definition in secondary dir", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );

    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );
    const def = createTestDefinition("auto-created-def");
    await secondaryRepo.save(testType, def);

    const found = await repo.findByNameGlobal("auto-created-def");
    assertNotEquals(found, null);
    assertEquals(found!.definition.name, "auto-created-def");
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal prefers primary over secondary", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );

    const primaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      false,
    );
    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );

    const primaryDef = Definition.create({
      name: "shared-name",
      globalArguments: { source: "primary" },
    });
    const secondaryDef = Definition.create({
      name: "shared-name",
      globalArguments: { source: "secondary" },
    });

    await primaryRepo.save(testType, primaryDef);
    await secondaryRepo.save(testType, secondaryDef);

    const found = await repo.findByNameGlobal("shared-name");
    assertNotEquals(found, null);
    assertEquals(found!.definition.id, primaryDef.id);
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal excludes secondary dir", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );

    const primaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      false,
    );
    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );

    await primaryRepo.save(testType, createTestDefinition("primary-def"));
    await secondaryRepo.save(testType, createTestDefinition("auto-def"));

    const all = await repo.findAllGlobal();
    assertEquals(all.length, 1);
    assertEquals(all[0].definition.name, "primary-def");
  });
});

Deno.test("YamlDefinitionRepository.findById falls back to secondary dir", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );

    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );
    const def = createTestDefinition("by-id-def");
    await secondaryRepo.save(testType, def);

    const found = await repo.findById(testType, def.id);
    assertNotEquals(found, null);
    assertEquals(found!.name, "by-id-def");
  });
});

// save() is the single seam every definition writer funnels through, so the
// guard refusing a literal for a sensitive global argument lives here; it reads
// the schema from the model registry

const SENSITIVE_SAVE_TYPE = ModelType.create("test/sensitive-save");
defineModel({
  type: SENSITIVE_SAVE_TYPE,
  version: "2026.05.29.1",
  globalArguments: z.object({
    apiKey: z.string().meta({ sensitive: true }),
    region: z.string(),
    users: z.array(z.object({
      userId: z.string(),
      password: z.string().meta({ sensitive: true }),
    })).optional(),
  }),
  methods: {},
});

Deno.test("YamlDefinitionRepository.save refuses a literal in a sensitive field of an array element and writes no file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "leaky-users",
      type: SENSITIVE_SAVE_TYPE.normalized,
      globalArguments: {
        apiKey: "${{ vault.get('creds', 'apiKey') }}",
        region: "us-east-1",
        users: [{ userId: "u", password: "SUPERSECRET123" }],
      },
    });

    const error = await assertRejects(
      () => repo.save(SENSITIVE_SAVE_TYPE, definition),
      UserError,
    );
    assertStringIncludes(error.message, "'users[0].password'");
    assertEquals(error.message.includes("SUPERSECRET123"), false);
    assertEquals(await repo.findById(SENSITIVE_SAVE_TYPE, definition.id), null);
  });
});

Deno.test("YamlDefinitionRepository.save accepts a vault.get expression in a sensitive field of an array element", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const users = [{ userId: "u", password: "${{ vault.get('creds', 'u') }}" }];
    const definition = Definition.create({
      name: "vaulted-users",
      type: SENSITIVE_SAVE_TYPE.normalized,
      globalArguments: {
        apiKey: "${{ vault.get('creds', 'apiKey') }}",
        region: "us-east-1",
        users,
      },
    });

    await repo.save(SENSITIVE_SAVE_TYPE, definition);
    const stored = await repo.findById(SENSITIVE_SAVE_TYPE, definition.id);
    assertEquals(stored?.globalArguments.users, users);
  });
});

Deno.test("YamlDefinitionRepository.save refuses a literal sensitive global arg and writes no file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "leaky",
      type: SENSITIVE_SAVE_TYPE.normalized,
      globalArguments: { apiKey: "SUPERSECRET123", region: "us-east-1" },
    });

    const error = await assertRejects(
      () => repo.save(SENSITIVE_SAVE_TYPE, definition),
      UserError,
    );
    assertStringIncludes(error.message, "apiKey");
    assertStringIncludes(error.message, "vault.get");

    // Fail-closed before the write: nothing landed on disk.
    assertEquals(await repo.findById(SENSITIVE_SAVE_TYPE, definition.id), null);
  });
});

Deno.test("YamlDefinitionRepository.save refuses a constant expression for a sensitive global arg", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "leaky-literal",
      type: SENSITIVE_SAVE_TYPE.normalized,
      globalArguments: {
        apiKey: "${{ literal('SUPERSECRET123') }}",
        region: "us-east-1",
      },
    });

    const error = await assertRejects(
      () => repo.save(SENSITIVE_SAVE_TYPE, definition),
      UserError,
    );
    assertStringIncludes(error.message, "constant expression");
    assertEquals(await repo.findById(SENSITIVE_SAVE_TYPE, definition.id), null);
  });
});

Deno.test("YamlDefinitionRepository.save accepts a vault.get expression for a sensitive global arg", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const expr = "${{ vault.get('creds', 'apiKey') }}";
    const definition = Definition.create({
      name: "vaulted",
      type: SENSITIVE_SAVE_TYPE.normalized,
      globalArguments: { apiKey: expr, region: "us-east-1" },
    });

    await repo.save(SENSITIVE_SAVE_TYPE, definition);

    const loaded = await repo.findById(SENSITIVE_SAVE_TYPE, definition.id);
    assertNotEquals(loaded, null);
    // The expression is persisted verbatim, unevaluated.
    assertEquals(loaded!.globalArguments.apiKey, expr);
  });
});

Deno.test("YamlDefinitionRepository.save is unaffected when no sensitive field carries a literal", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "no-secret",
      type: SENSITIVE_SAVE_TYPE.normalized,
      globalArguments: { region: "us-east-1" },
    });

    await repo.save(SENSITIVE_SAVE_TYPE, definition);

    assertNotEquals(
      await repo.findById(SENSITIVE_SAVE_TYPE, definition.id),
      null,
    );
  });
});

Deno.test("YamlDefinitionRepository.save passes through an unregistered type (schema unknown)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    // testType is not registered, so the schema is unknown and sensitivity
    // cannot be determined — the write proceeds (matches model get behavior).
    const definition = Definition.create({
      name: "unknown-type",
      type: testType.normalized,
      globalArguments: { key: "value" },
    });

    await repo.save(testType, definition);

    assertNotEquals(await repo.findById(testType, definition.id), null);
  });
});

Deno.test("YamlDefinitionRepository.save writes name-based filename for kebab-case names", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("my-server");

    await repo.save(testType, definition);

    const namePath = join(
      dir,
      "models",
      testType.toDirectoryPath(),
      "my-server.yaml",
    );
    const stat = await Deno.stat(namePath);
    assertEquals(stat.isFile, true);

    const uuidPath = join(
      dir,
      "models",
      testType.toDirectoryPath(),
      `${definition.id}.yaml`,
    );
    try {
      await Deno.stat(uuidPath);
      assertEquals(true, false, "UUID file should not exist");
    } catch (error) {
      assertEquals(error instanceof Deno.errors.NotFound, true);
    }
  });
});

Deno.test("YamlDefinitionRepository.save migrates UUID file to name-based on edit", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("migrate-me");

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${definition.id}.yaml`);
    const data = definition.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(uuidPath, toCleanYaml(data));

    const loaded = await repo.findById(testType, definition.id);
    assertNotEquals(loaded, null);
    await repo.save(testType, loaded!);

    const namePath = join(typeDir, "migrate-me.yaml");
    const stat = await Deno.stat(namePath);
    assertEquals(stat.isFile, true);

    try {
      await Deno.stat(uuidPath);
      assertEquals(true, false, "UUID file should have been removed");
    } catch (error) {
      assertEquals(error instanceof Deno.errors.NotFound, true);
    }
  });
});

Deno.test("YamlDefinitionRepository.getPath returns name-based path after save", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("path-test");

    await repo.save(testType, definition);

    const path = repo.getPath(testType, definition.id);
    assertStringIncludes(path, "path-test.yaml");
  });
});

Deno.test("YamlDefinitionRepository.getPath returns UUID path for legacy files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("legacy-file");

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${definition.id}.yaml`);
    const data = definition.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(uuidPath, toCleanYaml(data));

    await repo.findById(testType, definition.id);
    const path = repo.getPath(testType, definition.id);
    assertStringIncludes(path, `${definition.id}.yaml`);
  });
});

Deno.test("YamlDefinitionRepository.findByName fast path works for name-based files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("fast-lookup");

    await repo.save(testType, definition);

    const found = await repo.findByName(testType, "fast-lookup");
    assertNotEquals(found, null);
    assertEquals(found!.id, definition.id);
  });
});

Deno.test("YamlDefinitionRepository.findByName falls through when file name diverges from content name", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const def1 = createTestDefinition("original");
    const def2 = createTestDefinition("renamed");

    await repo.save(testType, def1);
    await repo.save(testType, def2);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const renamedPath = join(typeDir, "renamed.yaml");
    const data = def2.toData();
    data.name = "original";
    data.type = testType.normalized;
    await Deno.writeTextFile(renamedPath, toCleanYaml(data));

    const found = await repo.findByName(testType, "renamed");
    assertEquals(found, null);
  });
});

Deno.test("YamlDefinitionRepository.delete handles name-based files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("delete-named");

    await repo.save(testType, definition);

    assertNotEquals(await repo.findById(testType, definition.id), null);

    await repo.delete(testType, definition.id);

    assertEquals(await repo.findById(testType, definition.id), null);

    const namePath = join(
      dir,
      "models",
      testType.toDirectoryPath(),
      "delete-named.yaml",
    );
    try {
      await Deno.stat(namePath);
      assertEquals(true, false, "File should have been removed");
    } catch (error) {
      assertEquals(error instanceof Deno.errors.NotFound, true);
    }
  });
});

Deno.test("YamlDefinitionRepository.delete handles cold cache with name-based files", async () => {
  await withTempDir(async (dir) => {
    const repo1 = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("cold-delete");
    await repo1.save(testType, definition);

    const repo2 = new YamlDefinitionRepository(dir);
    await repo2.delete(testType, definition.id);

    assertEquals(await repo2.findById(testType, definition.id), null);
  });
});

Deno.test("YamlDefinitionRepository.findAll throws UserError on EMFILE", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");
    await repo.save(testType, goodDef);

    const originalReadTextFile = Deno.readTextFile;
    Deno.readTextFile = () => {
      throw Object.assign(new Error("Too many open files (os error 24)"), {
        code: "EMFILE",
      });
    };
    try {
      const error = await assertRejects(
        () => repo.findAll(testType),
        UserError,
      );
      assertStringIncludes(error.message, "Too many open files");
      assertStringIncludes(error.message, "ulimit -n");
    } finally {
      Deno.readTextFile = originalReadTextFile;
    }
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal throws UserError on EMFILE", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");
    await repo.save(testType, goodDef);

    const originalReadTextFile = Deno.readTextFile;
    Deno.readTextFile = () => {
      throw Object.assign(new Error("Too many open files (os error 24)"), {
        code: "EMFILE",
      });
    };
    try {
      const error = await assertRejects(
        () => repo.findByNameGlobal("good-def"),
        UserError,
      );
      assertStringIncludes(error.message, "Too many open files");
      assertStringIncludes(error.message, "ulimit -n");
    } finally {
      Deno.readTextFile = originalReadTextFile;
    }
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal throws UserError on EACCES", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const goodDef = createTestDefinition("good-def");
    await repo.save(testType, goodDef);

    const originalReadTextFile = Deno.readTextFile;
    Deno.readTextFile = () => {
      throw Object.assign(new Error("Permission denied (os error 13)"), {
        code: "EACCES",
      });
    };
    try {
      const error = await assertRejects(
        () => repo.findAllGlobal(),
        UserError,
      );
      assertStringIncludes(error.message, "Permission denied");
      assertStringIncludes(error.message, "ulimit -n");
    } finally {
      Deno.readTextFile = originalReadTextFile;
    }
  });
});

Deno.test("YamlDefinitionRepository.save: skips write when data is unchanged", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("unchanged-def");

    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "unchanged-def.yaml");

    await Deno.utime(filePath, new Date(), new Date(0));
    const statAfterUtime = await Deno.stat(filePath);
    assertEquals(statAfterUtime.mtime?.getTime(), 0);

    await repo.save(testType, definition);

    const statAfterSave = await Deno.stat(filePath);
    assertEquals(
      statAfterSave.mtime?.getTime(),
      0,
      "File was rewritten despite unchanged data",
    );

    const loaded = await repo.findById(testType, definition.id);
    assertEquals(loaded!.name, "unchanged-def");
  });
});

Deno.test("YamlDefinitionRepository.save: writes when data has changed", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("changed-def");

    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "changed-def.yaml");

    await Deno.utime(filePath, new Date(), new Date(0));

    definition.setGlobalArgument("newKey", "newValue");
    await repo.save(testType, definition);

    const statAfterSave = await Deno.stat(filePath);
    assertNotEquals(
      statAfterSave.mtime?.getTime(),
      0,
      "File was not rewritten despite changed data",
    );

    const loaded = await repo.findById(testType, definition.id);
    assertEquals(loaded!.globalArguments.newKey, "newValue");
  });
});

Deno.test("YamlDefinitionRepository.save: preserves YAML comments when data changes", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("commented-def");

    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "commented-def.yaml");

    const original = await Deno.readTextFile(filePath);
    const withComments = "# This is an important header comment\n" + original
      .replace(
        "globalArguments:",
        "globalArguments: # inline comment on globalArguments",
      );
    await Deno.writeTextFile(filePath, withComments);

    definition.setTag("env", "prod");
    await repo.save(testType, definition);

    const saved = await Deno.readTextFile(filePath);
    assertStringIncludes(saved, "# This is an important header comment");
    assertStringIncludes(saved, "# inline comment on globalArguments");
    assertStringIncludes(saved, "env: prod");
  });
});

Deno.test("YamlDefinitionRepository.save: preserves comments inside globalArguments on unchanged keys", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "deep-comments",
      globalArguments: {
        rootVolume: 64,
        instanceType: "m5.large",
      },
    });

    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "deep-comments.yaml");

    const original = await Deno.readTextFile(filePath);
    const withComment = original.replace(
      "rootVolume: 64",
      "# 64GB needed for the ML model cache — do not reduce\n  rootVolume: 64",
    );
    await Deno.writeTextFile(filePath, withComment);

    definition.setGlobalArgument("instanceType", "m5.xlarge");
    await repo.save(testType, definition);

    const saved = await Deno.readTextFile(filePath);
    assertStringIncludes(
      saved,
      "# 64GB needed for the ML model cache",
      "Comment inside globalArguments was lost",
    );
    assertStringIncludes(saved, "rootVolume: 64");
    assertStringIncludes(saved, "m5.xlarge");
  });
});

Deno.test("YamlDefinitionRepository.save: new definitions always write", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("brand-new");

    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "brand-new.yaml");
    const content = await Deno.readTextFile(filePath);
    assertStringIncludes(content, "brand-new");
  });
});

Deno.test("YamlDefinitionRepository.save: preserves quotes on timestamp strings in sequences and retains comments", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "timestamp-enums",
      globalArguments: {
        stages: [
          {
            artifacts: [
              {
                schema: {
                  properties: {
                    rolloutStartedAt: {
                      enum: ["2026-09-03T01:02:03Z"],
                    },
                    rolloutDate: {
                      enum: ["2026-09-03"],
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    });

    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "timestamp-enums.yaml");

    const original = await Deno.readTextFile(filePath);
    const withComment = "# Regression test — do not remove\n" + original;
    await Deno.writeTextFile(filePath, withComment);

    definition.setTag("env", "prod");
    await repo.save(testType, definition);

    const saved = await Deno.readTextFile(filePath);

    assertStringIncludes(
      saved,
      "# Regression test — do not remove",
      "Comment was lost during merge",
    );

    assertStringIncludes(saved, "env: prod");
    const rfc3339Unquoted = /- 2026-09-03T01:02:03Z\s/;
    const dateOnlyUnquoted = /- 2026-09-03\s/;
    assertEquals(
      rfc3339Unquoted.test(saved),
      false,
      "RFC 3339 timestamp lost its quotes in raw YAML output",
    );
    assertEquals(
      dateOnlyUnquoted.test(saved),
      false,
      "Date-only timestamp lost its quotes in raw YAML output",
    );

    const reloaded = parseYaml(saved) as Record<string, unknown>;
    const globalArgs = reloaded.globalArguments as Record<string, unknown>;
    const stages = globalArgs.stages as Array<Record<string, unknown>>;
    const artifacts = stages[0].artifacts as Array<Record<string, unknown>>;
    const schema = artifacts[0].schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const rolloutStartedAt = properties.rolloutStartedAt as Record<
      string,
      unknown
    >;
    const rolloutDate = properties.rolloutDate as Record<string, unknown>;

    assertEquals(
      typeof (rolloutStartedAt.enum as unknown[])[0],
      "string",
      "RFC 3339 timestamp was parsed as Date by @std/yaml after save",
    );
    assertEquals(
      typeof (rolloutDate.enum as unknown[])[0],
      "string",
      "Date-only value was parsed as Date by @std/yaml after save",
    );
  });
});

// these pin the efficiency claim by counting filesystem reads, never by timing;
// the counter wraps Deno.readTextFile and is restored in a finally
async function countingReads<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const original = Deno.readTextFile;
  let count = 0;
  Deno.readTextFile = ((...args: Parameters<typeof original>) => {
    count++;
    return original(...args);
  }) as typeof original;
  try {
    return [await fn(), count];
  } finally {
    Deno.readTextFile = original;
  }
}

async function writeLegacyNamedFile(
  baseDir: string,
  definition: Definition,
): Promise<string> {
  const typeDir = join(baseDir, testType.toDirectoryPath());
  await ensureDir(typeDir);
  const path = join(typeDir, `${definition.id}.yaml`);
  const data = definition.toData();
  data.type = testType.normalized;
  await Deno.writeTextFile(path, toCleanYaml(data));
  return path;
}

Deno.test("YamlDefinitionRepository.findByName reuses a hint for legacy-filename definitions", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const target = createTestDefinition("hinted-def");
    await writeLegacyNamedFile(join(dir, "models"), target);
    for (let i = 0; i < 5; i++) {
      await writeLegacyNamedFile(
        join(dir, "models"),
        createTestDefinition(`noise-${i}`),
      );
    }

    const [first, firstReads] = await countingReads(() =>
      repo.findByName(testType, "hinted-def")
    );
    assertEquals(first?.name, "hinted-def");

    const [second, secondReads] = await countingReads(() =>
      repo.findByName(testType, "hinted-def")
    );
    assertEquals(second?.name, "hinted-def");
    assertEquals(second?.id, target.id);
    // Two reads: the name-derived fast path's ENOENT probe (this name is
    // filename-safe, so it is still attempted) plus the hinted file itself.
    // Constant regardless of repository size, where discovery parsed every file.
    assertEquals(secondReads, 2);
    assertEquals(firstReads > secondReads, true);
  });
});

Deno.test("YamlDefinitionRepository.findByName hints names that are not filename-safe", async () => {
  await withTempDir(async (dir) => {
    // A scoped @collective/name is a legal definition name but can never be a
    // name-derived filename, so it never takes the isFilenameSafeDefinitionName
    // fast path. It only resolves in constant time if the hint check sits
    // OUTSIDE that guard.
    const repo = new YamlDefinitionRepository(dir);
    const scoped = "@acme/scoped-model";
    const target = createTestDefinition(scoped);
    await writeLegacyNamedFile(join(dir, "models"), target);
    for (let i = 0; i < 3; i++) {
      await writeLegacyNamedFile(
        join(dir, "models"),
        createTestDefinition(`filler-${i}`),
      );
    }

    assertEquals((await repo.findByName(testType, scoped))?.id, target.id);

    const [second, secondReads] = await countingReads(() =>
      repo.findByName(testType, scoped)
    );
    assertEquals(second?.id, target.id);
    assertEquals(secondReads, 1);
  });
});

Deno.test("YamlDefinitionRepository.findByName hints definitions in the secondary auto-definitions dir", async () => {
  await withTempDir(async (dir) => {
    // The dominant real-world slow path: auto-created definitions are written
    // as `{uuid}.yaml` into .swamp/auto-definitions, so every name lookup misses
    // the filename fast path, walks the primary dir, then walks the secondary.
    const repo = new YamlDefinitionRepository(dir);
    const target = createTestDefinition("auto-created");
    await writeLegacyNamedFile(
      join(dir, ".swamp", "auto-definitions"),
      target,
    );
    await repo.save(testType, createTestDefinition("primary-noise"));

    assertEquals(
      (await repo.findByName(testType, "auto-created"))?.id,
      target.id,
    );

    const [second, secondReads] = await countingReads(() =>
      repo.findByName(testType, "auto-created")
    );
    assertEquals(second?.id, target.id);
    // Three reads: the primary dir's ENOENT probe, the primary walk (which must
    // still run so a primary definition of the same name keeps precedence), and
    // the hinted file itself — but no walk of the secondary directory.
    assertEquals(secondReads, 3);
  });
});

async function writeNameDerivedFile(
  baseDir: string,
  definition: Definition,
): Promise<string> {
  const typeDir = join(baseDir, testType.toDirectoryPath());
  await ensureDir(typeDir);
  const path = join(typeDir, `${definition.name}.yaml`);
  const data = definition.toData();
  data.type = testType.normalized;
  await Deno.writeTextFile(path, toCleanYaml(data));
  return path;
}

Deno.test("YamlDefinitionRepository.findByName misses a new auto-definition name without reading every auto-definition again (swamp-club#3984)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const auto = join(dir, ".swamp", "auto-definitions");
    for (let i = 0; i < 20; i++) {
      await writeNameDerivedFile(auto, createTestDefinition(`worker-${i}`));
    }

    const [first, firstReads] = await countingReads(() =>
      repo.findByName(testType, "new-worker")
    );
    assertEquals(first, null);
    assertEquals(firstReads >= 20, true);

    // The re-check an auto-creating run makes under its lock, and the next
    // new name: neither reads the stored definitions again.
    const [again, againReads] = await countingReads(() =>
      repo.findByName(testType, "new-worker")
    );
    assertEquals(again, null);
    assertEquals(againReads < 20, true);

    await writeNameDerivedFile(auto, createTestDefinition("new-worker"));
    const [next, nextReads] = await countingReads(() =>
      repo.findByName(testType, "next-worker")
    );
    assertEquals(next, null);
    assertEquals(nextReads < 20, true);
  });
});

Deno.test("YamlDefinitionRepository.findByName finds a legacy or mismatched auto-definition stored after a miss (swamp-club#3984)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const auto = join(dir, ".swamp", "auto-definitions");
    await writeNameDerivedFile(auto, createTestDefinition("noise"));
    assertEquals(await repo.findByName(testType, "late-legacy"), null);
    assertEquals(await repo.findByName(testType, "late-mismatched"), null);

    const legacy = createTestDefinition("late-legacy");
    await writeLegacyNamedFile(auto, legacy);
    const mismatched = createTestDefinition("late-mismatched");
    const path = await writeNameDerivedFile(auto, mismatched);
    await Deno.rename(path, join(dirname(path), "elsewhere.yaml"));

    assertEquals(
      (await repo.findByName(testType, "late-legacy"))?.id,
      legacy.id,
    );
    assertEquals(
      (await repo.findByName(testType, "late-mismatched"))?.id,
      mismatched.id,
    );
  });
});

Deno.test({
  name:
    "YamlDefinitionRepository.findByName raises an I/O error on an auto-definition it cannot read, rather than finding none (swamp-club#3984)",
  // Windows has no file modes; root reads any file whatever its mode.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlDefinitionRepository(dir);
      const auto = join(dir, ".swamp", "auto-definitions");
      const path = await writeNameDerivedFile(
        auto,
        createTestDefinition("stored-worker"),
      );
      assertEquals(await repo.findByName(testType, "new-worker"), null);

      // An auto-creating run must not take it for a missing definition and
      // write a new one over it.
      await Deno.chmod(path, 0o000);
      try {
        await assertRejects(
          () => repo.findByName(testType, "stored-worker"),
          UserError,
          "Failed to read definition file",
        );
      } finally {
        await Deno.chmod(path, 0o644);
      }
    });
  },
});

Deno.test("YamlDefinitionRepository.findByNameGlobal reuses a hint across calls", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const target = createTestDefinition("global-hinted");
    await writeLegacyNamedFile(join(dir, "models"), target);
    for (let i = 0; i < 4; i++) {
      await writeLegacyNamedFile(
        join(dir, "models"),
        createTestDefinition(`other-${i}`),
      );
    }

    const first = await repo.findByNameGlobal("global-hinted");
    assertEquals(first?.definition.id, target.id);
    assertEquals(first?.type.normalized, testType.normalized);

    const [second, secondReads] = await countingReads(() =>
      repo.findByNameGlobal("global-hinted")
    );
    assertEquals(second?.definition.id, target.id);
    assertEquals(second?.type.normalized, testType.normalized);
    assertEquals(secondReads, 1);
  });
});

Deno.test("YamlDefinitionRepository hints do not hide an external rename", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const target = createTestDefinition("before-rename");
    const path = await writeLegacyNamedFile(join(dir, "models"), target);

    assertEquals(
      (await repo.findByName(testType, "before-rename"))?.id,
      target.id,
    );
    assertEquals(
      (await repo.findByNameGlobal("before-rename"))?.definition.id,
      target.id,
    );

    const data = target.toData();
    data.name = "after-rename";
    data.type = testType.normalized;
    await Deno.writeTextFile(path, toCleanYaml(data));

    assertEquals(await repo.findByName(testType, "before-rename"), null);
    assertEquals(await repo.findByNameGlobal("before-rename"), null);
    assertEquals(
      (await repo.findByName(testType, "after-rename"))?.id,
      target.id,
    );
    assertEquals(
      (await repo.findByNameGlobal("after-rename"))?.definition.id,
      target.id,
    );
  });
});

Deno.test("YamlDefinitionRepository hints do not hide an external delete", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const target = createTestDefinition("doomed-def");
    const path = await writeLegacyNamedFile(join(dir, "models"), target);

    assertEquals(
      (await repo.findByName(testType, "doomed-def"))?.id,
      target.id,
    );
    assertEquals(
      (await repo.findByNameGlobal("doomed-def"))?.definition.id,
      target.id,
    );

    await Deno.remove(path);

    assertEquals(await repo.findByName(testType, "doomed-def"), null);
    assertEquals(await repo.findByNameGlobal("doomed-def"), null);
  });
});

Deno.test("YamlDefinitionRepository hints do not hide an externally added definition", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const first = createTestDefinition("resident");
    await writeLegacyNamedFile(join(dir, "models"), first);

    assertEquals((await repo.findByName(testType, "resident"))?.id, first.id);
    assertEquals(await repo.findByName(testType, "newcomer"), null);
    assertEquals(await repo.findByNameGlobal("newcomer"), null);

    const added = createTestDefinition("newcomer");
    await writeLegacyNamedFile(join(dir, "models"), added);

    assertEquals((await repo.findByName(testType, "newcomer"))?.id, added.id);
    assertEquals(
      (await repo.findByNameGlobal("newcomer"))?.definition.id,
      added.id,
    );
  });
});

Deno.test("YamlDefinitionRepository hint rejects a path swapped for an escaping symlink", async () => {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      const repo = new YamlDefinitionRepository(dir);
      const target = createTestDefinition("swap-target");
      const path = await writeLegacyNamedFile(join(dir, "models"), target);

      assertEquals(
        (await repo.findByName(testType, "swap-target"))?.id,
        target.id,
      );

      // Replace it with a symlink to an identical definition outside the repo.
      // Discovery validates every symlink it follows, so the hinted read must
      // not quietly bypass that check.
      const escaped = join(outside, "escaped.yaml");
      const data = target.toData();
      data.type = testType.normalized;
      await Deno.writeTextFile(escaped, toCleanYaml(data));
      await Deno.remove(path);
      await Deno.symlink(escaped, path, { type: "file" });

      // The hint must not serve it. Discovery then warns and skips the
      // traversing symlink too, so the definition is simply not found — the
      // same outcome as if the hint had never existed.
      assertEquals(await repo.findByName(testType, "swap-target"), null);
    });
  });
});

Deno.test("YamlDefinitionRepository hints never let a secondary definition shadow a primary one", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const auto = createTestDefinition("shared-name");
    await writeLegacyNamedFile(join(dir, ".swamp", "auto-definitions"), auto);

    assertEquals((await repo.findByName(testType, "shared-name"))?.id, auto.id);
    assertEquals(
      (await repo.findByNameGlobal("shared-name"))?.definition.id,
      auto.id,
    );

    // A primary definition of the same name appears. It is legacy-named, so
    // only the primary walk can find it — a hint that skipped that walk would
    // keep returning the auto-definition forever.
    const primary = createTestDefinition("shared-name");
    await writeLegacyNamedFile(join(dir, "models"), primary);

    assertEquals(
      (await repo.findByName(testType, "shared-name"))?.id,
      primary.id,
    );
    assertEquals(
      (await repo.findByNameGlobal("shared-name"))?.definition.id,
      primary.id,
    );
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal skips definitions with an invalid type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    // "/" normalizes to the empty string, which ModelType.create rejects.
    const writeWithType = async (def: Definition, type: string) => {
      const data = def.toData();
      data.type = type;
      await Deno.writeTextFile(
        join(typeDir, `${def.id}.yaml`),
        toCleanYaml(data),
      );
    };

    // Discovery warns and skips a file it cannot type, so the name resolves to
    // nothing — and must keep doing so rather than throwing from a hint.
    const ghost = createTestDefinition("ghost");
    await writeWithType(ghost, "/");
    assertEquals(await repo.findByNameGlobal("ghost"), null);
    assertEquals(await repo.findByNameGlobal("ghost"), null);

    const spirit = createTestDefinition("spirit");
    await writeWithType(spirit, testType.normalized);
    assertEquals(
      (await repo.findByNameGlobal("spirit"))?.definition.id,
      spirit.id,
    );
    await writeWithType(spirit, "/");
    assertEquals(await repo.findByNameGlobal("spirit"), null);
  });
});

// save must not overwrite typeVersion with the registered model's version: that
// marks a stale instance current without migrating it and strands it from later
// upgrade chains

const STALE_SAVE_TYPE = ModelType.create("test/stale-save");

defineModel({
  type: STALE_SAVE_TYPE,
  version: "2026.06.01.1",
  globalArguments: z.object({ project: z.string() }),
  methods: {},
});

Deno.test("YamlDefinitionRepository.save does not advance a definition's typeVersion", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = Definition.create({
      name: "stale-instance",
      type: STALE_SAVE_TYPE.normalized,
      typeVersion: "2026.01.01.1",
      globalArguments: { project: "demo" },
    });

    await repo.save(STALE_SAVE_TYPE, definition);

    const reloaded = await repo.findByName(STALE_SAVE_TYPE, "stale-instance");
    assertEquals(reloaded?.typeVersion, "2026.01.01.1");
    assertEquals(reloaded?.globalArguments, { project: "demo" });
  });
});

Deno.test("YamlDefinitionRepository.save leaves an absent typeVersion absent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = Definition.create({
      name: "legacy-instance",
      type: STALE_SAVE_TYPE.normalized,
      globalArguments: { project: "demo" },
    });

    await repo.save(STALE_SAVE_TYPE, definition);

    // An absent typeVersion is the recorded signal for a legacy pre-CalVer
    // definition. Backfilling it here would strand exactly those definitions.
    const path = repo.getPath(STALE_SAVE_TYPE, definition.id);
    const data = parseYaml(await Deno.readTextFile(path)) as Record<
      string,
      unknown
    >;
    assertEquals(data.typeVersion, undefined);
    assertEquals(data.type, STALE_SAVE_TYPE.normalized);
  });
});

Deno.test("YamlDefinitionRepository.save preserves a typeVersion ahead of the model", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = Definition.create({
      name: "ahead-instance",
      type: STALE_SAVE_TYPE.normalized,
      typeVersion: "2027.01.01.1",
      globalArguments: { project: "demo" },
    });

    await repo.save(STALE_SAVE_TYPE, definition);

    const reloaded = await repo.findByName(STALE_SAVE_TYPE, "ahead-instance");
    assertEquals(reloaded?.typeVersion, "2027.01.01.1");
  });
});

Deno.test("YamlDefinitionRepository.isAutoDefinition tells models/ from auto-definitions by ID", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );
    const primaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      false,
    );
    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );
    const otherType = ModelType.create("test/other");
    const authored = createTestDefinition("authored");
    const auto = createTestDefinition("auto");
    const primaryBoth = createTestDefinition("both");
    const autoBoth = createTestDefinition("both");
    const firstTwin = createTestDefinition("twin");
    const secondTwin = createTestDefinition("twin");
    await primaryRepo.save(testType, authored);
    await secondaryRepo.save(testType, auto);
    await primaryRepo.save(testType, primaryBoth);
    await secondaryRepo.save(testType, autoBoth);
    await primaryRepo.save(testType, firstTwin);
    await primaryRepo.save(otherType, secondTwin);

    assertEquals(await repo.isAutoDefinition(authored, testType), false);
    assertEquals(await repo.isAutoDefinition(auto, testType), true);
    assertEquals(await repo.isAutoDefinition(primaryBoth, testType), false);
    assertEquals(await repo.isAutoDefinition(autoBoth, testType), true);
    assertEquals(await repo.isAutoDefinition(firstTwin, testType), false);
    assertEquals(await repo.isAutoDefinition(secondTwin, otherType), false);
  });
});

Deno.test("YamlDefinitionRepository.isAutoDefinition is false with no auto-definitions dir", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      join(dir, "models"),
      false,
    );
    assertEquals(
      await repo.isAutoDefinition(createTestDefinition("x"), testType),
      false,
    );
  });
});

function autoDefinitionFixture(dir: string) {
  const primaryDir = join(dir, "models");
  const secondaryDir = join(dir, ".swamp", "auto-definitions");
  return {
    primaryDir,
    secondaryDir,
    autoRepo: new YamlDefinitionRepository(dir, undefined, secondaryDir, false),
    primaryRepo: new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      false,
    ),
    sharedRepo: (
      eventBus?: EventBus,
      markDirty?: (path?: string) => Promise<void>,
    ) =>
      new YamlDefinitionRepository(
        dir,
        eventBus,
        primaryDir,
        secondaryDir,
        markDirty,
      ),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function listYamlFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(current)) {
        const path = join(current, entry.name);
        if (entry.isDirectory) await walk(path);
        else if (entry.name.endsWith(".yaml")) found.push(path);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await walk(dir);
  return found;
}

Deno.test("YamlDefinitionRepository.delete: removes an auto-definition on a cold repo", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-cold");
    await fx.autoRepo.save(testType, def);
    const file = fx.autoRepo.getPath(testType, def.id);

    await fx.sharedRepo().delete(testType, def.id);

    assertEquals(await fileExists(file), false);
  });
});

Deno.test("YamlDefinitionRepository.delete: removes an auto-definition after findByName", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-by-name");
    await fx.autoRepo.save(testType, def);
    const file = fx.autoRepo.getPath(testType, def.id);

    const repo = fx.sharedRepo();
    const found = await repo.findByName(testType, "auto-by-name");
    await repo.delete(testType, found!.id);

    assertEquals(await fileExists(file), false);
  });
});

Deno.test("YamlDefinitionRepository.delete: removes an auto-definition after findById", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-by-id");
    await fx.autoRepo.save(testType, def);
    const file = fx.autoRepo.getPath(testType, def.id);

    const repo = fx.sharedRepo();
    await repo.findById(testType, def.id);
    await repo.delete(testType, def.id);

    assertEquals(await fileExists(file), false);
  });
});

Deno.test("YamlDefinitionRepository.delete: removes an auto-definition stored under its id", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = Definition.fromData({
      ...createTestDefinition("placeholder").toData(),
      name: "Not Filename Safe",
    });
    await fx.autoRepo.save(testType, def);
    const file = fx.autoRepo.getPath(testType, def.id);
    assertEquals(file.endsWith(`${def.id}.yaml`), true);

    await fx.sharedRepo().delete(testType, def.id);

    assertEquals(await fileExists(file), false);
  });
});

Deno.test("YamlDefinitionRepository.getPath: reports the auto-definition file after findById and findByName", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-path");
    await fx.autoRepo.save(testType, def);
    const file = fx.autoRepo.getPath(testType, def.id);

    const byId = fx.sharedRepo();
    await byId.findById(testType, def.id);
    assertPathEquals(byId.getPath(testType, def.id), file);

    const byName = fx.sharedRepo();
    await byName.findByName(testType, "auto-path");
    assertPathEquals(byName.getPath(testType, def.id), file);
  });
});

Deno.test("YamlDefinitionRepository.delete: leaves a same-named definition with another id in models/", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const auto = createTestDefinition("shared-name");
    const authored = createTestDefinition("shared-name");
    await fx.autoRepo.save(testType, auto);
    await fx.primaryRepo.save(testType, authored);
    const autoFile = fx.autoRepo.getPath(testType, auto.id);
    const authoredFile = fx.primaryRepo.getPath(testType, authored.id);

    await fx.sharedRepo().delete(testType, auto.id);

    assertEquals(await fileExists(autoFile), false);
    assertEquals(await fileExists(authoredFile), true);
  });
});

Deno.test("YamlDefinitionRepository.delete: leaves a same-named auto-definition with another id", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const auto = createTestDefinition("shared-name");
    const authored = createTestDefinition("shared-name");
    await fx.autoRepo.save(testType, auto);
    await fx.primaryRepo.save(testType, authored);
    const autoFile = fx.autoRepo.getPath(testType, auto.id);
    const authoredFile = fx.primaryRepo.getPath(testType, authored.id);

    await fx.sharedRepo().delete(testType, authored.id);

    assertEquals(await fileExists(authoredFile), false);
    assertEquals(await fileExists(autoFile), true);
  });
});

Deno.test("YamlDefinitionRepository.delete: never removes a name-path file declaring another id", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const target = createTestDefinition("renamed-away");
    await fx.primaryRepo.save(testType, target);
    const targetFile = fx.primaryRepo.getPath(testType, target.id);
    const other = createTestDefinition("renamed-away");
    await Deno.writeTextFile(
      targetFile,
      toCleanYaml({ ...other.toData(), type: testType.normalized }),
    );

    await new YamlDefinitionRepository(dir, undefined, fx.primaryDir, false)
      .delete(testType, target.id);

    assertEquals(await fileExists(targetFile), true);
  });
});

Deno.test("YamlDefinitionRepository.delete: removes an id present in both directories", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("both-dirs");
    await fx.autoRepo.save(testType, def);
    await fx.primaryRepo.save(testType, def);

    await fx.sharedRepo().delete(testType, def.id);

    assertEquals(await listYamlFiles(fx.primaryDir), []);
    assertEquals(await listYamlFiles(fx.secondaryDir), []);
  });
});

Deno.test("YamlDefinitionRepository.delete: cleans empty auto-definition dirs but keeps the root", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-cleanup");
    await fx.autoRepo.save(testType, def);

    await fx.sharedRepo().delete(testType, def.id);

    assertEquals(
      await fileExists(join(fx.secondaryDir, testType.toDirectoryPath())),
      false,
    );
    assertEquals(await fileExists(fx.secondaryDir), true);
  });
});

Deno.test("YamlDefinitionRepository.delete: publishes DefinitionDeleted and marks the auto-definition dirty", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-events");
    await fx.autoRepo.save(testType, def);
    const file = fx.autoRepo.getPath(testType, def.id);

    const eventBus = new EventBus();
    const deletedNames: string[] = [];
    eventBus.subscribeAll((event) => {
      if (event.type === "DefinitionDeleted") {
        deletedNames.push(event.definitionName);
      }
    });
    const marked: string[] = [];
    await fx.sharedRepo(eventBus, (path) => {
      if (path) marked.push(path);
      return Promise.resolve();
    }).delete(testType, def.id);

    assertEquals(deletedNames, ["auto-events"]);
    assertEquals(marked.some((path) => path === file), true);
  });
});

Deno.test("YamlDefinitionRepository.delete: leaves auto-definitions alone with secondary search off", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-untouched");
    await fx.autoRepo.save(testType, def);
    const file = fx.autoRepo.getPath(testType, def.id);

    await new YamlDefinitionRepository(dir, undefined, fx.primaryDir, false)
      .delete(testType, def.id);

    assertEquals(await fileExists(file), true);
  });
});

Deno.test("YamlDefinitionRepository.save: keeps an auto-definition in place after any lookup", async () => {
  for (
    const lookup of ["none", "findById", "findByName", "findByNameGlobal"]
  ) {
    await withTempDir(async (dir) => {
      const fx = autoDefinitionFixture(dir);
      const def = createTestDefinition("auto-save");
      await fx.autoRepo.save(testType, def);
      const file = fx.autoRepo.getPath(testType, def.id);

      const repo = fx.sharedRepo();
      if (lookup === "findById") await repo.findById(testType, def.id);
      if (lookup === "findByName") await repo.findByName(testType, def.name);
      if (lookup === "findByNameGlobal") await repo.findByNameGlobal(def.name);
      await repo.save(
        testType,
        Definition.fromData({
          ...def.toData(),
          globalArguments: { key: "updated" },
        }),
      );

      assertEquals(await listYamlFiles(fx.primaryDir), [], lookup);
      const saved = parseYaml(await Deno.readTextFile(file)) as {
        globalArguments: Record<string, unknown>;
      };
      assertEquals(saved.globalArguments, { key: "updated" }, lookup);
    });
  }
});

Deno.test("YamlDefinitionRepository.save: renaming an auto-definition keeps it an auto-definition", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-old-name");
    await fx.autoRepo.save(testType, def);
    const oldFile = fx.autoRepo.getPath(testType, def.id);

    const repo = fx.sharedRepo();
    await repo.findById(testType, def.id);
    await repo.save(
      testType,
      Definition.fromData({ ...def.toData(), name: "auto-new-name" }),
    );

    assertEquals(await fileExists(oldFile), false);
    assertEquals(await listYamlFiles(fx.primaryDir), []);
    assertPathEquals(
      repo.getPath(testType, def.id),
      join(fx.secondaryDir, testType.toDirectoryPath(), "auto-new-name.yaml"),
    );
  });
});

Deno.test("YamlDefinitionRepository.save: new definitions and models/ definitions still save to models/", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    // A same-named auto-definition must not pull a new definition into
    // the auto-definitions dir: placement follows the id.
    await fx.autoRepo.save(testType, createTestDefinition("placed"));
    const fresh = createTestDefinition("placed");
    const authored = createTestDefinition("authored");
    await fx.primaryRepo.save(testType, authored);

    const repo = fx.sharedRepo();
    await repo.save(testType, fresh);
    await repo.save(
      testType,
      Definition.fromData({
        ...authored.toData(),
        globalArguments: { key: "updated" },
      }),
    );

    const typeDir = join(fx.primaryDir, testType.toDirectoryPath());
    assertEquals(await fileExists(join(typeDir, "placed.yaml")), true);
    assertEquals(await fileExists(join(typeDir, "authored.yaml")), true);
    assertEquals((await listYamlFiles(fx.secondaryDir)).length, 1);
  });
});

Deno.test("YamlDefinitionRepository.save: with secondary search off writes to its own directory", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const def = createTestDefinition("auto-shadowed");
    await fx.autoRepo.save(testType, def);

    await new YamlDefinitionRepository(dir, undefined, fx.primaryDir, false)
      .save(testType, def);

    assertEquals((await listYamlFiles(fx.primaryDir)).length, 1);
    assertEquals((await listYamlFiles(fx.secondaryDir)).length, 1);
  });
});

Deno.test("YamlDefinitionRepository.findAllByIdGlobal returns every definition declaring the id, auto-definitions and unregistered types included", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );
    const shared = Definition.create({ name: "prod-db", globalArguments: {} });
    await repo.save(testType, shared);
    const path = repo.getPath(testType, shared.id);
    await Deno.writeTextFile(
      join(dirname(path), "safe-model.yaml"),
      (await Deno.readTextFile(path)).replace(
        "name: prod-db",
        "name: safe-model",
      ),
    );
    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );
    await secondaryRepo.save(
      testType,
      Definition.create({
        id: shared.id,
        name: "auto-db",
        globalArguments: {},
      }),
    );
    // Saved through a fresh repository: saving an id this one has seen is
    // read as a rename, which would remove prod-db's file.
    const unregistered = ModelType.create("@acme/uninstalled");
    await new YamlDefinitionRepository(dir, undefined, primaryDir, false).save(
      unregistered,
      Definition.create({
        id: shared.id,
        name: "acme-db",
        type: unregistered.normalized,
        globalArguments: {},
      }),
    );
    await repo.save(testType, createTestDefinition("unrelated"));

    const found = await repo.findAllByIdGlobal(shared.id);
    assertEquals(
      found.map((entry) => entry.definition.name).sort(),
      ["acme-db", "auto-db", "prod-db", "safe-model"],
    );
    assertEquals(
      found.find((entry) => entry.definition.name === "acme-db")?.type
        .normalized,
      "@acme/uninstalled",
    );
  });
});

Deno.test("YamlDefinitionRepository.findAllByIdGlobal leaves where findById looks unchanged", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );
    const primary = Definition.create({
      name: "prod-db",
      globalArguments: {},
    });
    await repo.save(testType, primary);
    await new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    ).save(
      testType,
      Definition.create({
        id: primary.id,
        name: "auto-db",
        globalArguments: {},
      }),
    );
    assertEquals((await repo.findById(testType, primary.id))?.name, "prod-db");

    // Reads the auto-definition last; a later findById must not follow it.
    assertEquals((await repo.findAllByIdGlobal(primary.id)).length, 2);
    assertEquals((await repo.findById(testType, primary.id))?.name, "prod-db");
  });
});

Deno.test("YamlDefinitionRepository.delete: stages a remove of the deleted file", async () => {
  await withTempDir(async (dir) => {
    const definition = createTestDefinition("probe");
    const seed = new YamlDefinitionRepository(dir);
    await seed.save(testType, definition);
    const path = seed.getPath(testType, definition.id);
    const { markDirty, marks, uow } = recordingUnitOfWork();
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      false,
      markDirty,
    );

    await runInUnitOfWork(uow, () => repo.delete(testType, definition.id));

    assertEquals(uow.staged(), [{ kind: "remove", path }, {
      kind: "remove",
      path,
    }]);
    assertEquals(marks, [path, path]);
    assertEquals(await pathExists(path), false);
  });
});

Deno.test("YamlDefinitionRepository.delete: stages a write when the file holds another definition and is kept", async () => {
  await withTempDir(async (dir) => {
    // Never saved: the id-named path it resolves to holds a definition
    // named with that id, which delete leaves alone.
    const ghost = createTestDefinition("ghost");
    const impostor = createTestDefinition(ghost.id);
    const seed = new YamlDefinitionRepository(dir);
    await seed.save(testType, impostor);
    const path = seed.getPath(testType, impostor.id);
    const { markDirty, marks, uow } = recordingUnitOfWork();
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      false,
      markDirty,
    );

    await runInUnitOfWork(uow, () => repo.delete(testType, ghost.id));

    assertEquals(uow.staged(), [{ kind: "write", path }, {
      kind: "write",
      path,
    }]);
    assertEquals(marks, [path, path]);
    assertEquals(await pathExists(path), true);
  });
});

const LONG_EXPRESSION =
  '${{ data.latest("some-other-model-with-a-long-name", "some-resource-name").attributes.someField }}';

function commentedDefinitionYaml(
  id: string,
  name: string,
  type: ModelType = testType,
): string {
  return [
    "# Design note: this definition derives its host from live data.",
    `type: ${type.normalized}`,
    "typeVersion: 2026.01.01.1",
    `id: ${id}`,
    `name: ${name}`,
    "version: 1",
    "tags: {}",
    "globalArguments:",
    "  # the filter exists because of overlapping CIDRs",
    "  key: value",
    `  expr: ${LONG_EXPRESSION}`,
    "methods: {}",
    "",
  ].join("\n");
}

function definitionFromYaml(
  yaml: string,
  overrides: Record<string, unknown> = {},
): Definition {
  return Definition.fromData(
    {
      ...(parseYaml(yaml) as Record<string, unknown>),
      ...overrides,
    } as Parameters<typeof Definition.fromData>[0],
  );
}

Deno.test("YamlDefinitionRepository.save: a uuid-named file keeps its comments and layout when it migrates with a change", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${id}.yaml`);
    const original = commentedDefinitionYaml(id, "moved-changed");
    await Deno.writeTextFile(uuidPath, original);

    await repo.save(
      testType,
      definitionFromYaml(original, { typeVersion: "2026.10.05.1" }),
    );

    assertEquals(
      await Deno.readTextFile(join(typeDir, "moved-changed.yaml")),
      original.replace(
        "typeVersion: 2026.01.01.1",
        "typeVersion: 2026.10.05.1",
      ),
    );
    assertEquals(await fileExists(uuidPath), false);
  });
});

Deno.test("YamlDefinitionRepository.save: a uuid-named file migrates byte-identically when nothing changed", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${id}.yaml`);
    const original = commentedDefinitionYaml(id, "moved-unchanged");
    await Deno.writeTextFile(uuidPath, original);

    await repo.save(testType, definitionFromYaml(original));

    assertEquals(
      await Deno.readTextFile(join(typeDir, "moved-unchanged.yaml")),
      original,
    );
    assertEquals(await fileExists(uuidPath), false);
  });
});

Deno.test("YamlDefinitionRepository.save: renaming a definition keeps its comments and removes the old file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const oldPath = join(typeDir, "old-name.yaml");
    const original = commentedDefinitionYaml(id, "old-name");
    await Deno.writeTextFile(oldPath, original);

    const loaded = await repo.findByName(testType, "old-name");
    await repo.save(
      testType,
      Definition.fromData({ ...loaded!.toData(), name: "new-name" }),
    );

    assertEquals(
      await Deno.readTextFile(join(typeDir, "new-name.yaml")),
      original.replace("name: old-name", "name: new-name"),
    );
    assertEquals(await fileExists(oldPath), false);
  });
});

Deno.test("YamlDefinitionRepository.save: a stale cached path holding another definition is neither merged from nor removed", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("hinted");
    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const hintedPath = join(typeDir, "hinted.yaml");
    const other = commentedDefinitionYaml(crypto.randomUUID(), "hinted");
    await Deno.writeTextFile(hintedPath, other);

    await repo.save(
      testType,
      Definition.fromData({ ...definition.toData(), name: "hinted-renamed" }),
    );

    assertEquals(await Deno.readTextFile(hintedPath), other);
    const saved = await Deno.readTextFile(
      join(typeDir, "hinted-renamed.yaml"),
    );
    assertEquals(saved.includes("#"), false);
    assertEquals(
      (parseYaml(saved) as Record<string, unknown>).id,
      definition.id,
    );
  });
});

Deno.test("YamlDefinitionRepository.save: a uuid-named file holding another definition is not removed", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = createTestDefinition("has-a-namesake");

    // A different definition that is *named* with this definition's id lives
    // at the same path a legacy file for it would.
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${definition.id}.yaml`);
    const other = commentedDefinitionYaml(crypto.randomUUID(), definition.id);
    await Deno.writeTextFile(uuidPath, other);

    await repo.save(testType, definition);

    assertEquals(await Deno.readTextFile(uuidPath), other);
    const saved = await Deno.readTextFile(
      join(typeDir, "has-a-namesake.yaml"),
    );
    assertEquals(saved.includes("#"), false);
  });
});

Deno.test("YamlDefinitionRepository.save: a long single-line expression is not re-wrapped when another key changes", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const filePath = join(typeDir, "long-line.yaml");
    const original = commentedDefinitionYaml(id, "long-line");
    await Deno.writeTextFile(filePath, original);

    await repo.save(
      testType,
      definitionFromYaml(original, { typeVersion: "2026.10.05.1" }),
    );

    assertEquals(
      await Deno.readTextFile(filePath),
      original.replace(
        "typeVersion: 2026.01.01.1",
        "typeVersion: 2026.10.05.1",
      ),
    );
  });
});

Deno.test("YamlDefinitionRepository.save: a file folded at 80 columns stays folded, even under a long comment", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "folded",
      globalArguments: { expr: LONG_EXPRESSION },
    });
    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "folded.yaml");
    const written = await Deno.readTextFile(filePath);
    const folded = written.match(/ {2}expr: >-\n(?: {4}.*\n)+/)?.[0];
    assertEquals(
      folded?.trimEnd().split("\n").length,
      3,
      "a fresh write folds the expression across lines",
    );
    const longComment = `# ${"why this exists ".repeat(8)}\n`;
    await Deno.writeTextFile(filePath, longComment + written);

    definition.setTag("env", "prod");
    await repo.save(testType, definition);

    const saved = await Deno.readTextFile(filePath);
    assertStringIncludes(saved, longComment);
    assertStringIncludes(saved, folded!);
    assertStringIncludes(saved, "env: prod");
  });
});

Deno.test("YamlDefinitionRepository.save: a file swamp folded stays folded beside a token too long to fold", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    // A fresh write folds what it can, and a URL with nowhere to break still
    // runs past 80 columns inside its block scalar. So does a long line of a
    // multi-line string, which is written as a literal block.
    const definition = Definition.create({
      name: "folded-with-url",
      globalArguments: {
        expr: LONG_EXPRESSION,
        url: `https://example.com/${"a-long-path-segment/".repeat(5)}`,
        script: `first line\n${"a long second line ".repeat(6)}\n`,
      },
    });
    await repo.save(testType, definition);

    const typeDir = join(dir, "models", testType.toDirectoryPath());
    const filePath = join(typeDir, "folded-with-url.yaml");
    const written = await Deno.readTextFile(filePath);
    assertEquals(
      written.split("\n").some((line) => line.length > 80),
      true,
      "the fresh write has a line past 80 columns",
    );

    definition.setTag("env", "prod");
    await repo.save(testType, definition);

    const withoutTags = (yaml: string) =>
      yaml.replace(/^tags:.*\n(?: {2}.*\n)*/m, "");
    assertEquals(
      withoutTags(await Deno.readTextFile(filePath)),
      withoutTags(written),
    );
  });
});

Deno.test("YamlDefinitionRepository.save: a quoted timestamp string keeps its quotes when the file migrates", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const original = [
      "# keep me",
      `type: ${testType.normalized}`,
      `id: ${id}`,
      "name: dated",
      "version: 1",
      "tags: {}",
      "globalArguments:",
      '  rolloutDate: "2026-09-03"',
      "  dates:",
      '    - "2026-09-03T01:02:03Z"',
      "methods: {}",
      "",
    ].join("\n");
    await Deno.writeTextFile(join(typeDir, `${id}.yaml`), original);

    await repo.save(
      testType,
      definitionFromYaml(original, { tags: { env: "prod" } }),
    );

    const saved = await Deno.readTextFile(join(typeDir, "dated.yaml"));
    assertStringIncludes(saved, "# keep me");
    const globalArgs = (parseYaml(saved) as Record<string, unknown>)
      .globalArguments as Record<string, unknown>;
    assertEquals(globalArgs.rolloutDate, "2026-09-03");
    assertEquals(globalArgs.dates, ["2026-09-03T01:02:03Z"]);
  });
});

Deno.test("YamlDefinitionRepository.save: a uuid-named file with a literal sensitive global arg is refused and left in place", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(
      dir,
      "models",
      SENSITIVE_SAVE_TYPE.toDirectoryPath(),
    );
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${id}.yaml`);
    const original = [
      "# hand-written, and leaking",
      `type: ${SENSITIVE_SAVE_TYPE.normalized}`,
      `id: ${id}`,
      "name: leaky-legacy",
      "version: 1",
      "tags: {}",
      "globalArguments:",
      "  apiKey: SUPERSECRET123",
      "  region: us-east-1",
      "methods: {}",
      "",
    ].join("\n");
    await Deno.writeTextFile(uuidPath, original);

    await assertRejects(
      () => repo.save(SENSITIVE_SAVE_TYPE, definitionFromYaml(original)),
      UserError,
    );

    assertEquals(await Deno.readTextFile(uuidPath), original);
    assertEquals(
      await fileExists(join(typeDir, "leaky-legacy.yaml")),
      false,
    );
  });
});

Deno.test("YamlDefinitionRepository.save: a uuid-named auto-definition keeps its comments and stays an auto-definition", async () => {
  await withTempDir(async (dir) => {
    const fx = autoDefinitionFixture(dir);
    const id = crypto.randomUUID();
    const typeDir = join(fx.secondaryDir, testType.toDirectoryPath());
    await ensureDir(typeDir);
    const original = commentedDefinitionYaml(id, "auto-commented");
    await Deno.writeTextFile(join(typeDir, `${id}.yaml`), original);

    const repo = fx.sharedRepo();
    await repo.save(
      testType,
      definitionFromYaml(original, { typeVersion: "2026.10.05.1" }),
    );

    assertEquals(
      await Deno.readTextFile(join(typeDir, "auto-commented.yaml")),
      original.replace(
        "typeVersion: 2026.01.01.1",
        "typeVersion: 2026.10.05.1",
      ),
    );
    assertEquals(await listYamlFiles(fx.secondaryDir), [
      join(typeDir, "auto-commented.yaml"),
    ]);
    assertEquals(await listYamlFiles(fx.primaryDir), []);
  });
});

Deno.test("YamlDefinitionRepository.save: an empty file at the target path does not stop the merge from the uuid-named file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${id}.yaml`);
    const namePath = join(typeDir, "beside-empty.yaml");
    const original = commentedDefinitionYaml(id, "beside-empty");
    await Deno.writeTextFile(uuidPath, original);
    await Deno.writeTextFile(namePath, "");

    await repo.save(
      testType,
      definitionFromYaml(original, { typeVersion: "2026.10.05.1" }),
    );

    assertEquals(
      await Deno.readTextFile(namePath),
      original.replace(
        "typeVersion: 2026.01.01.1",
        "typeVersion: 2026.10.05.1",
      ),
    );
    assertEquals(await fileExists(uuidPath), false);
  });
});

Deno.test("YamlDefinitionRepository.save: an unreadable uuid-named file fails the save instead of being replaced", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const uuidPath = join(typeDir, `${id}.yaml`);
    const original = commentedDefinitionYaml(id, "unreadable");
    await Deno.writeTextFile(uuidPath, original);
    const definition = definitionFromYaml(original, {
      typeVersion: "2026.10.05.1",
    });

    const originalReadTextFile = Deno.readTextFile;
    Deno.readTextFile = (path, options) => {
      if (String(path) === uuidPath) {
        throw Object.assign(new Error("Permission denied (os error 13)"), {
          code: "EACCES",
        });
      }
      return originalReadTextFile(path, options);
    };
    try {
      const error = await assertRejects(() => repo.save(testType, definition));
      assertStringIncludes(String(error), "Permission denied");
    } finally {
      Deno.readTextFile = originalReadTextFile;
    }

    assertEquals(await Deno.readTextFile(uuidPath), original);
    assertEquals(await fileExists(join(typeDir, "unreadable.yaml")), false);
  });
});

Deno.test("YamlDefinitionRepository.findAll: returns definitions in file-name order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    for (const name of ["mango", "zebra", "apple", "kiwi", "banana"]) {
      await repo.save(testType, createTestDefinition(name));
    }

    const fresh = new YamlDefinitionRepository(dir);
    assertEquals(
      (await fresh.findAll(testType)).map((d) => d.name),
      ["apple", "banana", "kiwi", "mango", "zebra"],
    );
  });
});

Deno.test("YamlDefinitionRepository.findAllGlobal: walks type directories and files in name order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const zeta = ModelType.create("test/zeta");
    const alpha = ModelType.create("test/alpha");
    await repo.save(zeta, createTestDefinition("mango"));
    await repo.save(alpha, createTestDefinition("zebra"));
    await repo.save(zeta, createTestDefinition("apple"));
    await repo.save(alpha, createTestDefinition("kiwi"));

    const fresh = new YamlDefinitionRepository(dir);
    assertEquals(
      (await fresh.findAllGlobal()).map((r) =>
        `${r.type.normalized}:${r.definition.name}`
      ),
      [
        "test/alpha:kiwi",
        "test/alpha:zebra",
        "test/zeta:apple",
        "test/zeta:mango",
      ],
    );
  });
});

Deno.test("YamlDefinitionRepository.findByName answers a secondary definition from its name-derived file (swamp-club#3405)", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );
    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );
    const named = createTestDefinition("worker-x");
    await secondaryRepo.save(testType, named);
    // An earlier-sorting file declaring the same name: a scan of the type
    // directory would return it first, the name-derived file does not.
    const stray = createTestDefinition("worker-x");
    const typeDir = join(secondaryDir, testType.toDirectoryPath());
    const strayData = stray.toData();
    strayData.type = testType.normalized;
    await Deno.writeTextFile(
      join(typeDir, "a-stray.yaml"),
      toCleanYaml(strayData),
    );

    const found = await repo.findByName(testType, "worker-x");
    assertEquals(found?.id, named.id);
  });
});

Deno.test("YamlDefinitionRepository.findByName prefers a primary definition over the secondary name-derived file (swamp-club#3405)", async () => {
  await withTempDir(async (dir) => {
    const primaryDir = join(dir, "models");
    const secondaryDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      secondaryDir,
    );
    const primaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      primaryDir,
      false,
    );
    const secondaryRepo = new YamlDefinitionRepository(
      dir,
      undefined,
      secondaryDir,
      false,
    );
    const primaryDef = createTestDefinition("shared-worker");
    await primaryRepo.save(testType, primaryDef);
    await secondaryRepo.save(testType, createTestDefinition("shared-worker"));

    const found = await repo.findByName(testType, "shared-worker");
    assertEquals(found?.id, primaryDef.id);
  });
});

function richDefinitionYaml(id: string, name: string): string {
  return [
    "# Hand-written header comment",
    `type: ${testType.normalized}`,
    "typeVersion: 2026.06.04.2",
    `id: ${id}`,
    `name: ${name}`,
    "version: 1",
    "tags: {}",
    "globalArguments:",
    "  recipients:",
    "    # the on-call alias",
    "    - oncall@example.com",
    "    - team@example.com",
    "  notes:",
    "    - this is a long note that the author",
    "      wrapped by hand across two lines",
    "  createTrigger:",
    "    arguments: &trigger_args",
    "      threshold: 5",
    "      window: 10m",
    "  updateTrigger: { arguments: *trigger_args }",
    "  filters:",
    "    - field: status",
    "      op: '='",
    "methods: {}",
    "",
  ].join("\n");
}

function jsonDataFromYaml(yaml: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(parseYaml(yaml)));
}

async function writeRichDefinition(
  dir: string,
): Promise<{ id: string; typeDir: string; original: string }> {
  const id = crypto.randomUUID();
  const typeDir = join(dir, "models", testType.toDirectoryPath());
  await ensureDir(typeDir);
  const original = richDefinitionYaml(id, "rich");
  await Deno.writeTextFile(join(typeDir, `${id}.yaml`), original);
  return { id, typeDir, original };
}

Deno.test("YamlDefinitionRepository.save: a typeVersion-only change keeps every other byte of a uuid-named file as it moves", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const { id, typeDir, original } = await writeRichDefinition(dir);

    await repo.save(
      testType,
      definitionFromYaml(original, { typeVersion: "2026.07.28.1" }),
    );

    assertEquals(
      await Deno.readTextFile(join(typeDir, "rich.yaml")),
      original.replace(
        "typeVersion: 2026.06.04.2",
        "typeVersion: 2026.07.28.1",
      ),
    );
    assertEquals(await fileExists(join(typeDir, `${id}.yaml`)), false);
  });
});

Deno.test("YamlDefinitionRepository.save: a structural change keeps comments in unchanged lists, aliases and quoting", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const { typeDir, original } = await writeRichDefinition(dir);
    const data = jsonDataFromYaml(original);
    data.tags = { env: "prod" };

    await repo.save(
      testType,
      Definition.fromData(data as Parameters<typeof Definition.fromData>[0]),
    );

    const saved = await Deno.readTextFile(join(typeDir, "rich.yaml"));
    assertStringIncludes(saved, "    # the on-call alias\n");
    assertStringIncludes(
      saved,
      "  updateTrigger: { arguments: *trigger_args }",
    );
    assertStringIncludes(saved, "      op: '='");
    assertEquals(jsonDataFromYaml(saved), data);
  });
});

Deno.test("YamlDefinitionRepository.save: changing an anchored map whose alias keeps its value expands the alias and reads back as saved", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const { typeDir, original } = await writeRichDefinition(dir);
    const data = jsonDataFromYaml(original);
    const args = data.globalArguments as Record<
      string,
      { arguments: Record<string, unknown> }
    >;
    args.createTrigger.arguments.threshold = 6;

    await repo.save(
      testType,
      Definition.fromData(data as Parameters<typeof Definition.fromData>[0]),
    );

    const saved = await Deno.readTextFile(join(typeDir, "rich.yaml"));
    assertEquals(jsonDataFromYaml(saved), data);
    assertEquals(saved.includes("&trigger_args"), false);
    assertEquals(saved.includes("*trigger_args"), false);
    assertStringIncludes(saved, "    # the on-call alias\n");
  });
});

Deno.test("YamlDefinitionRepository.save: changing an anchored map and its alias alike reads back as saved", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const { typeDir, original } = await writeRichDefinition(dir);
    const data = jsonDataFromYaml(original);
    const args = data.globalArguments as Record<
      string,
      { arguments: Record<string, unknown> }
    >;
    args.createTrigger.arguments.threshold = 6;
    args.updateTrigger.arguments.threshold = 6;

    await repo.save(
      testType,
      Definition.fromData(data as Parameters<typeof Definition.fromData>[0]),
    );

    const saved = await Deno.readTextFile(join(typeDir, "rich.yaml"));
    assertEquals(jsonDataFromYaml(saved), data);
    assertStringIncludes(saved, "    # the on-call alias\n");
  });
});

Deno.test("YamlDefinitionRepository.save: a changed string that would read as another type in place is still saved as a string", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const { typeDir, original } = await writeRichDefinition(dir);
    const data = jsonDataFromYaml(original);
    const args = data.globalArguments as Record<string, unknown>;
    (args.recipients as string[])[1] = "true";

    await repo.save(
      testType,
      Definition.fromData(data as Parameters<typeof Definition.fromData>[0]),
    );

    const saved = await Deno.readTextFile(join(typeDir, "rich.yaml"));
    assertEquals(jsonDataFromYaml(saved), data);
  });
});

function scalarStylesYaml(id: string): string {
  return [
    "# hand-written comment",
    `type: ${testType.normalized}`,
    "typeVersion: 2026.06.04.2",
    `id: ${id}`,
    "name: styles",
    "version: 1",
    "tags: {}",
    "globalArguments:",
    "  empty: ''",
    "  plain: hello",
    "  count: 3",
    "  script: |",
    "    echo one",
    "    echo two",
    "  # npm yaml's 1.1 schema reads this as a float; @std/yaml as a string",
    "  neighbour: e0",
    "methods: {}",
    "",
  ].join("\n");
}

for (
  const { label, key, value, line } of [
    {
      label: "a quoted empty string edited to null",
      key: "empty",
      value: null,
      line: "  empty: null",
    },
    {
      label: "a plain string edited to a string that reads as a number",
      key: "plain",
      value: "123",
      line: '  plain: "123"',
    },
    {
      label: "a plain string edited to a string that reads as a boolean",
      key: "plain",
      value: "true",
      line: '  plain: "true"',
    },
    {
      label: "a plain string edited to one the CST quotes on its own",
      key: "plain",
      value: '"quoted" text',
      line: `  plain: '"quoted" text'`,
    },
    {
      label: "a plain string edited to a multi-line string",
      key: "plain",
      value: "line one\nline two",
      line: "  plain: |-\n    line one\n    line two",
    },
    {
      label: "a plain string edited to a boolean",
      key: "plain",
      value: true,
      line: "  plain: true",
    },
    {
      label: "a number edited to a string that reads as a number",
      key: "count",
      value: "4",
      line: '  count: "4"',
    },
    {
      label: "a block literal edited to another multi-line string",
      key: "script",
      value: "echo one\necho three\n",
      line: "  script: |\n    echo one\n    echo three",
    },
    {
      label: "a block literal edited to null",
      key: "script",
      value: null,
      line: "  script: null",
    },
  ]
) {
  Deno.test(`YamlDefinitionRepository.save: ${label} is rewritten in place, keeping every other byte (swamp-club#3541)`, async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlDefinitionRepository(dir);
      const id = crypto.randomUUID();
      const typeDir = join(dir, "models", testType.toDirectoryPath());
      await ensureDir(typeDir);
      const path = join(typeDir, "styles.yaml");
      const original = scalarStylesYaml(id);
      await Deno.writeTextFile(path, original);
      const data = jsonDataFromYaml(original);
      (data.globalArguments as Record<string, unknown>)[key] = value;

      await repo.save(
        testType,
        Definition.fromData(data as Parameters<typeof Definition.fromData>[0]),
      );

      const saved = await Deno.readTextFile(path);
      assertEquals(jsonDataFromYaml(saved), data);
      const lines = original.split("\n");
      const start = lines.findIndex((l) => l.startsWith(`  ${key}:`));
      const end = key === "script" ? start + 3 : start + 1;
      lines.splice(start, end - start, line);
      assertEquals(saved, lines.join("\n"));
    });
  });
}

Deno.test("YamlDefinitionRepository.save: changing an anchored list that unchanged aliases still use reads back as saved", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const id = crypto.randomUUID();
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    const original = [
      `type: ${testType.normalized}`,
      "typeVersion: 2026.06.04.2",
      `id: ${id}`,
      "name: shared-list",
      "version: 1",
      "tags: {}",
      "globalArguments:",
      "  # shared by every use",
      "  defs: &d",
      "    - a",
      "    - b",
      "  uses:",
      "    - *d",
      "    - *d",
      "methods: {}",
      "",
    ].join("\n");
    await Deno.writeTextFile(join(typeDir, `${id}.yaml`), original);
    const data = jsonDataFromYaml(original);
    (data.globalArguments as Record<string, unknown>).defs = ["a", "b", "z"];

    await repo.save(
      testType,
      Definition.fromData(data as Parameters<typeof Definition.fromData>[0]),
    );

    const saved = await Deno.readTextFile(join(typeDir, "shared-list.yaml"));
    assertEquals(jsonDataFromYaml(saved), data);
    assertStringIncludes(saved, "  # shared by every use\n");
  });
});

Deno.test("YamlDefinitionRepository: an auto-definition the lookup names unreadable fails lookups by name, even with no directory for its type; an absent name is not found (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    // A registered type with no directory in this checkout: its only
    // auto-definition could not be materialised.
    const type = ModelType.create(
      `test/unreadable-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type,
      version: "2026.01.01.1",
      methods: {},
    });
    try {
      const autoDir = join(dir, ".swamp", "auto-definitions");
      const unreadablePath = join(autoDir, type.toDirectoryPath(), "lost.yaml");
      const repo = new YamlDefinitionRepository(
        dir,
        undefined,
        undefined,
        autoDir,
        undefined,
        (path) =>
          Promise.resolve(
            path === unreadablePath
              ? new UserError("unreadable", "datastore_v3_record_unreadable")
              : undefined,
          ),
      );
      await assertRejects(
        () => repo.findByNameGlobal("lost"),
        UserError,
        "unreadable",
      );
      await assertRejects(
        () => repo.findByName(type, "lost"),
        UserError,
        "unreadable",
      );
      assertEquals(await repo.findByNameGlobal("other"), null);
      assertEquals(await repo.findByName(type, "other"), null);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("YamlDefinitionRepository: an auto-definition stored under its id that the lookup names unreadable fails findById and findByIdGlobal; one of an unregistered type with no directory fails findByNameGlobal (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const type = ModelType.create("test/registered-nowhere");
    const id = crypto.randomUUID() as DefinitionId;
    const byId = join(autoDir, type.toDirectoryPath(), `${id}.yaml`);
    const byName = join(autoDir, "test", "unregistered-type", "lost.yaml");
    const { lookup, errors } = fakeUnreadableLookup([byId, byName]);
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
      undefined,
      lookup,
    );
    assertEquals(
      await assertRejects(() => repo.findById(type, id)),
      errors.get(byId),
    );
    assertEquals(
      await assertRejects(() => repo.findByIdGlobal(id)),
      errors.get(byId),
    );
    assertEquals(
      await assertRejects(() => repo.findByNameGlobal("lost")),
      errors.get(byName),
    );
    assertEquals(
      await repo.findById(type, crypto.randomUUID() as DefinitionId),
      null,
    );
    assertEquals(await repo.findByNameGlobal("other"), null);
  });
});

Deno.test("YamlDefinitionRepository: listings with auto-definitions keep the readable ones and warn naming the unreadable ones (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const type = ModelType.create("test/listed");
    const lost = join(autoDir, type.toDirectoryPath(), "lost.yaml");
    const { lookup } = fakeUnreadableLookup([lost]);
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
      undefined,
      lookup,
    );
    const kept = Definition.create({ name: "kept" });
    await repo.save(type, kept);
    const warnings = await captureUnreadableWarnings(async () => {
      assertEquals(
        (await repo.findAllIncludingAutoGlobal()).map((e) => e.definition.id),
        [kept.id],
      );
      // A miss by id cannot tell whether the unreadable one is it.
      assertEquals(
        await repo.findByIdGlobal(crypto.randomUUID() as DefinitionId),
        null,
      );
    });
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], lost);
  });
});

Deno.test("YamlDefinitionRepository.findById: a miss warns naming the unreadable auto-definitions of its type, not another type's (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const type = ModelType.create("test/miss-by-id");
    const otherType = ModelType.create("test/miss-by-id-other");
    const lost = join(autoDir, type.toDirectoryPath(), "lost.yaml");
    const otherLost = join(autoDir, otherType.toDirectoryPath(), "lost.yaml");
    const { lookup } = fakeUnreadableLookup([lost, otherLost]);
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
      undefined,
      lookup,
    );
    const warnings = await captureUnreadableWarnings(async () => {
      // A miss by id cannot tell whether the one stored under a name is it.
      assertEquals(
        await repo.findById(type, crypto.randomUUID() as DefinitionId),
        null,
      );
    });
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], lost);
    assertEquals(warnings[0].includes(otherLost), false, warnings[0]);
  });
});

Deno.test("YamlDefinitionRepository: definitionRoots and readDefinitionFile read one file as a scan of every definition does", async () => {
  await withTempDir(async (dir) => {
    const primary = join(dir, "models");
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const repo = new YamlDefinitionRepository(dir, undefined, primary, autoDir);
    assertEquals(repo.definitionRoots(), [primary, autoDir]);
    assertEquals(
      new YamlDefinitionRepository(dir, undefined, primary, false)
        .definitionRoots(),
      [primary],
    );

    const definition = createTestDefinition("untyped");
    const path = join(autoDir, "test", "typed-by-path", "untyped.yaml");
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, toCleanYaml({ ...definition.toData() }));
    const broken = join(autoDir, "test", "typed-by-path", "broken.yaml");
    await Deno.writeTextFile(broken, "id: [unterminated\n");

    const read = await repo.readDefinitionFile(
      path,
      ["test", "typed-by-path"],
      false,
    );
    assertEquals(read?.definition.id, definition.id);
    assertEquals(read?.type.normalized, "test/typed-by-path");
    assertEquals(
      (await repo.findAllIncludingAutoGlobal()).map((e) => [
        e.definition.id,
        e.type.normalized,
      ]),
      [[definition.id, "test/typed-by-path"]],
    );
    assertEquals(
      await repo.readDefinitionFile(broken, ["test", "typed-by-path"], false),
      null,
    );
  });
});

async function observeLookup<T>(
  lookup: () => Promise<T>,
  check: (
    spans: readonly ReadableSpan[],
    result: T,
  ) => void,
): Promise<void> {
  await withObservedSpans(async (spans) => {
    const result = await withDiagnosticArea("enrollment", lookup);
    assertEquals(diagnosticPhases(spans, "definition_lookup").length, 1);
    check(spans, result);
  });
}

function lookupAttributes(
  spans: readonly ReadableSpan[],
) {
  const lookup = findSpan(spans, "swamp.diagnostic.definition_lookup");
  return {
    method: lookup.attributes["swamp.diagnostic.lookup_method"],
    hit: lookup.attributes["swamp.diagnostic.hit"],
    source: lookup.attributes["swamp.diagnostic.source"],
  };
}

Deno.test("YamlDefinitionRepository.findByName: a name-derived hit is one definition_lookup phase with no scan", async () => {
  await withTempDir(async (dir) => {
    await new YamlDefinitionRepository(dir).save(
      testType,
      createTestDefinition("named"),
    );
    const repo = new YamlDefinitionRepository(dir);
    await observeLookup(() => repo.findByName(testType, "named"), (spans) => {
      assertEquals(lookupAttributes(spans), {
        method: "name_file",
        hit: true,
        source: "primary",
      });
      const lookup = findSpan(spans, "swamp.diagnostic.definition_lookup");
      assertEquals(lookup.attributes["swamp.diagnostic.area"], "enrollment");
      assertEquals(
        lookup.attributes["swamp.diagnostic.definition_type"],
        testType.normalized,
      );
      assertEquals(lookup.attributes["swamp.diagnostic.files_read"], 1);
      assertEquals(diagnosticPhases(spans, "definition_scan").length, 0);
    });
  });
});

Deno.test("YamlDefinitionRepository.findByName: a primary scan is a definition_scan child with its counts", async () => {
  await withTempDir(async (dir) => {
    const target = createTestDefinition("scanned");
    await writeLegacyNamedFile(join(dir, "models"), target);
    await writeLegacyNamedFile(
      join(dir, "models"),
      createTestDefinition("noise"),
    );
    await Deno.writeTextFile(
      join(dir, "models", testType.toDirectoryPath(), "broken.yaml"),
      "id: [unclosed",
    );
    const repo = new YamlDefinitionRepository(dir);
    await observeLookup(
      () =>
        withDiagnosticAttributes(
          { "swamp.diagnostic.lookup_attempt": "initial" },
          () => repo.findByName(testType, "scanned"),
        ),
      (spans, found) => {
        assertEquals(found?.id, target.id);
        assertEquals(lookupAttributes(spans), {
          method: "primary_scan",
          hit: true,
          source: "primary",
        });
        const lookup = findSpan(spans, "swamp.diagnostic.definition_lookup");
        const scan = findSpan(spans, "swamp.diagnostic.definition_scan");
        assert(isChildOf(scan, lookup));
        assertEquals(
          scan.attributes["swamp.diagnostic.lookup_attempt"],
          "initial",
        );
        assertEquals(scan.attributes["swamp.diagnostic.scan_root"], "primary");
        assertEquals(
          scan.attributes["swamp.diagnostic.scan_strategy"],
          "full_listing",
        );
        assertEquals(scan.attributes["swamp.diagnostic.files_examined"], 3);
        assertEquals(scan.attributes["swamp.diagnostic.files_read"], 3);
        assertEquals(scan.attributes["swamp.diagnostic.broken_files"], 1);
        assertEquals(scan.attributes["swamp.diagnostic.definitions"], 2);
        assert((scan.attributes["swamp.diagnostic.bytes_read"] as number) > 0);
        assertEquals(
          typeof scan.attributes["swamp.diagnostic.read_work_ms"],
          "number",
        );
        assertEquals(
          typeof scan.attributes["swamp.diagnostic.parse_work_ms"],
          "number",
        );
      },
    );
  });
});

Deno.test("YamlDefinitionRepository.findByName: a repeated scan hit is answered by the primary hint", async () => {
  await withTempDir(async (dir) => {
    await writeLegacyNamedFile(
      join(dir, "models"),
      createTestDefinition("hinted"),
    );
    const repo = new YamlDefinitionRepository(dir);
    await repo.findByName(testType, "hinted");
    await observeLookup(() => repo.findByName(testType, "hinted"), (spans) => {
      assertEquals(lookupAttributes(spans), {
        method: "primary_hint",
        hit: true,
        source: "primary",
      });
      assertEquals(diagnosticPhases(spans, "definition_scan").length, 0);
    });
  });
});

Deno.test("YamlDefinitionRepository.findByName: a miss scans both roots and reports no method", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    await observeLookup(() => repo.findByName(testType, "absent"), (spans) => {
      assertEquals(lookupAttributes(spans), {
        method: "none",
        hit: false,
        source: "none",
      });
      assertEquals(
        findSpan(spans, "swamp.diagnostic.definition_lookup")
          .attributes["swamp.outcome"],
        "ok",
      );
      assertEquals(
        diagnosticPhases(spans, "definition_scan").map((s) => [
          s.attributes["swamp.diagnostic.scan_root"],
          s.attributes["swamp.diagnostic.scan_strategy"],
        ]),
        [["primary", "full_listing"], ["auto", "name_index"]],
      );
    });
  });
});

Deno.test("YamlDefinitionRepository.findByName: an auto-definition at its name-derived path reports secondary_name_file", async () => {
  await withTempDir(async (dir) => {
    const auto = join(dir, ".swamp", "auto-definitions");
    const definition = createTestDefinition("auto-named");
    const typeDir = join(auto, testType.toDirectoryPath());
    await ensureDir(typeDir);
    const data = definition.toData();
    data.type = testType.normalized;
    await Deno.writeTextFile(
      join(typeDir, "auto-named.yaml"),
      toCleanYaml(data),
    );
    const repo = new YamlDefinitionRepository(dir);
    await observeLookup(
      () => repo.findByName(testType, "auto-named"),
      (spans) => {
        assertEquals(lookupAttributes(spans), {
          method: "secondary_name_file",
          hit: true,
          source: "auto",
        });
        assertEquals(
          diagnosticPhases(spans, "definition_scan").map((s) =>
            s.attributes["swamp.diagnostic.scan_root"]
          ),
          ["primary"],
        );
      },
    );
    await observeLookup(
      () => repo.findByName(testType, "auto-named"),
      (spans) => assertEquals(lookupAttributes(spans).method, "secondary_hint"),
    );
  });
});

Deno.test("YamlDefinitionRepository.findByName: an auto-definition at another path reports secondary_index", async () => {
  await withTempDir(async (dir) => {
    const target = createTestDefinition("auto-created");
    await writeLegacyNamedFile(join(dir, ".swamp", "auto-definitions"), target);
    const repo = new YamlDefinitionRepository(dir);
    await observeLookup(
      () => repo.findByName(testType, "auto-created"),
      (spans, found) => {
        assertEquals(found?.id, target.id);
        assertEquals(lookupAttributes(spans), {
          method: "secondary_index",
          hit: true,
          source: "auto",
        });
        const scan = diagnosticPhases(spans, "definition_scan").find((s) =>
          s.attributes["swamp.diagnostic.scan_root"] === "auto"
        )!;
        assertEquals(
          scan.attributes["swamp.diagnostic.scan_strategy"],
          "name_index",
        );
        assertEquals(scan.attributes["swamp.diagnostic.index_checks_run"], 1);
        assertEquals(scan.attributes["swamp.diagnostic.index_entries"], 1);
        assert((scan.attributes["swamp.diagnostic.files_read"] as number) >= 1);
        assert(
          isChildOf(
            findSpan(spans, "swamp.definition.name_index.validate"),
            scan,
          ),
        );
      },
    );
  });
});

Deno.test("YamlDefinitionRepository.findByName: outside a diagnostic area it exports nothing", async () => {
  await withTempDir(async (dir) => {
    await writeLegacyNamedFile(
      join(dir, "models"),
      createTestDefinition("quiet"),
    );
    const repo = new YamlDefinitionRepository(dir);
    await withObservedSpans(async (spans) => {
      await repo.findByName(testType, "quiet");
      assertEquals(spans.length, 0);
    });
  });
});

Deno.test("YamlDefinitionRepository.delete: measures lookup, removal, event and staging into the running phase", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, new EventBus());
    const definition = createTestDefinition("measured-delete");
    await repo.save(testType, definition);
    await withObservedSpans(async (spans) => {
      await withDiagnosticArea("worker_delete", () =>
        observeDiagnosticPhase(
          "definition_removal",
          {},
          () => repo.delete(testType, definition.id, definition.name),
        ));
      const removal = findSpan(spans, "swamp.diagnostic.definition_removal");
      for (
        const work of ["lookup", "file_remove", "event_publish", "change_stage"]
      ) {
        assertEquals(
          typeof removal.attributes[`swamp.diagnostic.${work}_work_ms`],
          "number",
          work,
        );
      }
    });
    assertEquals(await repo.findById(testType, definition.id), null);
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal: counts its walk and its reads, then the hint that spares the next one", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    await repo.save(testType, createTestDefinition("global-other"));
    await repo.save(testType, createTestDefinition("global-target"));
    await withObservedSpans(async (spans) => {
      await withDiagnosticArea("worker_delete", async () => {
        for (let i = 0; i < 2; i++) {
          await observeDiagnosticPhase(
            "definition_resolve",
            {},
            () => repo.findByNameGlobal("global-target"),
          );
        }
      });
      const [walk, hinted] = diagnosticPhases(spans, "definition_resolve");
      assertEquals(walk.attributes["swamp.diagnostic.primary_walks"], 1);
      assert(
        (walk.attributes["swamp.diagnostic.files_read"] as number) >= 1,
      );
      assertEquals(hinted.attributes["swamp.diagnostic.name_hint_hits"], 1);
      assertEquals(
        hinted.attributes["swamp.diagnostic.primary_walks"],
        undefined,
      );
    });
  });
});

function indexedRepository(
  dir: string,
  unreadable?: ConstructorParameters<typeof YamlDefinitionRepository>[5],
) {
  const repo = new YamlDefinitionRepository(
    dir,
    undefined,
    undefined,
    join(dir, ".swamp", "auto-definitions"),
    undefined,
    unreadable,
  );
  const index = new DefinitionIdIndex(repo);
  const calls = { lookups: 0 };
  const counted: DefinitionNameIndex = {
    findByName: (name) => {
      calls.lookups++;
      return index.findByName(name);
    },
  };
  repo.useNameIndex(counted);
  return { repo, calls };
}

async function writeYaml(path: string, id: string, name: string, type: string) {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(
    path,
    `type: ${type}\nid: ${id}\nname: ${name}\nversion: 1\n`,
  );
}

Deno.test("YamlDefinitionRepository.findByNameGlobalFromIndex: answers as the walk does, a definition shadowing an auto-definition, and a primary hit spares the next lookup the index", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const primaryId = crypto.randomUUID() as DefinitionId;
    const autoId = crypto.randomUUID() as DefinitionId;
    await writeYaml(
      join(autoDir, "test", "a", "both.yaml"),
      autoId,
      "both",
      "test/a",
    );
    await writeYaml(
      join(autoDir, "test", "a", "auto.yaml"),
      autoId,
      "auto",
      "test/a",
    );
    await writeYaml(
      join(dir, "models", "test", "b", "both.yaml"),
      primaryId,
      "both",
      "test/b",
    );
    const { repo, calls } = indexedRepository(dir);
    const walked = new YamlDefinitionRepository(dir);

    for (const name of ["both", "auto", "missing"]) {
      const viaIndex = await repo.findByNameGlobalFromIndex(name);
      const viaWalk = await walked.findByNameGlobal(name);
      assertEquals(viaIndex?.definition.id, viaWalk?.definition.id, name);
      assertEquals(viaIndex?.type.normalized, viaWalk?.type.normalized, name);
    }
    assertEquals(calls.lookups, 3);
    assertEquals(
      (await repo.findByNameGlobalFromIndex("both"))?.definition.id,
      primaryId,
    );
    assertEquals(calls.lookups, 3);
    // An auto-definition hit is not trusted to stay unshadowed.
    assertEquals(
      (await repo.findByNameGlobalFromIndex("auto"))?.definition.id,
      autoId,
    );
    assertEquals(calls.lookups, 4);
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobalFromIndex: a miss through the name index still fails on an auto-definition the datastore could not materialise (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const byName = join(autoDir, "test", "unregistered-type", "lost.yaml");
    const { lookup, errors } = fakeUnreadableLookup([byName]);
    const { repo, calls } = indexedRepository(dir, lookup);
    assertEquals(
      await assertRejects(() => repo.findByNameGlobalFromIndex("lost")),
      errors.get(byName),
    );
    assertEquals(await repo.findByNameGlobalFromIndex("other"), null);
    assertEquals(calls.lookups, 2);
  });
});

Deno.test("YamlDefinitionRepository.useNameIndex: refuses a second index", async () => {
  await withTempDir((dir) => {
    const { repo } = indexedRepository(dir);
    assertThrows(
      () => repo.useNameIndex({ findByName: () => Promise.resolve(null) }),
      Error,
      "already has a name index",
    );
    return Promise.resolve();
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobalFromIndex: inside a diagnostic area a lookup through the name index is a definition_lookup phase over the index's definition_scan", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    await writeYaml(
      join(autoDir, "test", "a", "d.yaml"),
      crypto.randomUUID(),
      "d",
      "test/a",
    );
    const { repo } = indexedRepository(dir);
    await withObservedSpans(async (spans) => {
      await withDiagnosticArea("enrollment", async () => {
        await repo.findByNameGlobalFromIndex("d");
        await repo.findByNameGlobalFromIndex("missing");
      });
      const lookups = diagnosticPhases(spans, "definition_lookup");
      assertEquals(
        lookups.map((p) => [
          p.attributes["swamp.diagnostic.lookup_method"],
          p.attributes["swamp.diagnostic.hit"],
          p.attributes["swamp.diagnostic.source"],
        ]),
        [["global_index", true, "auto"], ["global_index", false, "none"]],
      );
      const scans = diagnosticPhases(spans, "definition_scan");
      assertEquals(scans.length, 2);
      for (const [i, scan] of scans.entries()) {
        assert(isChildOf(scan, lookups[i]));
      }
    });
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobal: walks every definition even with a name index attached, so a rename written in place is seen at once", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "models", "test", "a", "file.yaml");
    const id = crypto.randomUUID() as DefinitionId;
    await writeYaml(path, id, "before", "test/a");
    const { repo, calls } = indexedRepository(dir);
    assertEquals(
      (await repo.findByNameGlobalFromIndex("before"))?.definition.id,
      id,
    );
    assertEquals(calls.lookups, 1);

    // Rewritten in place: the index is not told until its directory moves.
    await writeYaml(path, id, "after", "test/a");
    assertEquals((await repo.findByNameGlobal("after"))?.definition.id, id);
    assertEquals(await repo.findByNameGlobal("before"), null);
    assertEquals(calls.lookups, 1);
  });
});

Deno.test("YamlDefinitionRepository.findByNameGlobalFromIndex: walks as findByNameGlobal does when no index is attached", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const id = crypto.randomUUID() as DefinitionId;
    await writeYaml(join(autoDir, "test", "a", "d.yaml"), id, "d", "test/a");
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
    );
    assertEquals(
      (await repo.findByNameGlobalFromIndex("d"))?.definition.id,
      id,
    );
    assertEquals(await repo.findByNameGlobalFromIndex("missing"), null);
  });
});

function idIndexedRepository(
  dir: string,
  unreadable?: ConstructorParameters<typeof YamlDefinitionRepository>[5],
) {
  const autoDir = join(dir, ".swamp", "auto-definitions");
  const repo = new YamlDefinitionRepository(
    dir,
    undefined,
    undefined,
    autoDir,
    undefined,
    unreadable,
  );
  const index = new DefinitionIdIndex(repo);
  const calls = { lookups: 0 };
  repo.useIdIndex({
    findAllById: (id) => {
      calls.lookups++;
      return index.findAllById(id);
    },
  });
  return { repo, calls, autoDir, primaryDir: join(dir, "models") };
}

// reads inside nested phases (index checks, primary scans) are not counted
async function filesRead(fn: () => Promise<unknown>): Promise<number> {
  const tally = new PhaseTally(true);
  await withDiagnosticTally("step_outputs", tally, fn);
  return tally.attributes()["swamp.diagnostic.files_read"] ?? 0;
}

Deno.test("YamlDefinitionRepository.findById: with an id index attached, an auto-definition stored under its name is found reading only its own file", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const ids: DefinitionId[] = [];
    for (let i = 0; i < 30; i++) {
      const id = crypto.randomUUID() as DefinitionId;
      ids.push(id);
      await writeYaml(
        join(autoDir, testType.toDirectoryPath(), `run-${i}.yaml`),
        id,
        `run-${i}`,
        testType.normalized,
      );
    }
    const { repo, calls } = idIndexedRepository(dir);
    // warms the index
    assertEquals(
      await repo.findById(testType, crypto.randomUUID() as DefinitionId),
      null,
    );

    let found: Definition | null = null;
    const reads = await filesRead(async () => {
      found = await repo.findById(testType, ids[3]);
    });
    assertEquals((found as Definition | null)?.name, "run-3");
    assertEquals(reads, 1);
    assertEquals(calls.lookups, 2);
    assertPathEquals(
      repo.getPath(testType, ids[3]),
      join(autoDir, testType.toDirectoryPath(), "run-3.yaml"),
    );

    // without an index the lookup reads the directory until it finds the id
    const scanning = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
    );
    const scanned = await filesRead(async () => {
      assertEquals((await scanning.findById(testType, ids[3]))?.name, "run-3");
    });
    assert(scanned > 1, `scan read ${scanned} files`);
  });
});

Deno.test("YamlDefinitionRepository.findById: with an id index attached, the auto-definition comes from the index, not a scan of the directory", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const id = crypto.randomUUID() as DefinitionId;
    const path = join(autoDir, testType.toDirectoryPath(), "on-disk.yaml");
    await writeYaml(path, id, "on-disk", testType.normalized);
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
    );
    const fromIndex = Definition.create({ id, name: "from-index" });
    const index: DefinitionIdLookup = {
      findAllById: (asked) =>
        Promise.resolve(
          asked === id
            ? [{
              definition: fromIndex,
              type: testType,
              path,
              segments: testType.normalized.split("/"),
              primary: false,
            }]
            : [],
        ),
    };
    repo.useIdIndex(index);
    assertEquals((await repo.findById(testType, id))?.name, "from-index");
  });
});

Deno.test("YamlDefinitionRepository.findById: with an id index attached, an auto-definition filed under another type is not this type's, and a definition still shadows an auto-definition with its id", async () => {
  await withTempDir(async (dir) => {
    const otherType = ModelType.create("test/other");
    const elsewhere = crypto.randomUUID() as DefinitionId;
    const shared = crypto.randomUUID() as DefinitionId;
    const { repo, autoDir, primaryDir } = idIndexedRepository(dir);
    await writeYaml(
      join(autoDir, otherType.toDirectoryPath(), "elsewhere.yaml"),
      elsewhere,
      "elsewhere",
      otherType.normalized,
    );
    await writeYaml(
      join(autoDir, testType.toDirectoryPath(), "auto.yaml"),
      shared,
      "auto",
      testType.normalized,
    );
    await writeYaml(
      join(primaryDir, testType.toDirectoryPath(), "primary.yaml"),
      shared,
      "primary",
      testType.normalized,
    );

    assertEquals(await repo.findById(testType, elsewhere), null);
    assertEquals(
      (await repo.findById(otherType, elsewhere))?.name,
      "elsewhere",
    );
    assertEquals((await repo.findById(testType, shared))?.name, "primary");
  });
});

Deno.test("YamlDefinitionRepository.findById: with an id index attached, an auto-definition stored under its id that the lookup names unreadable still fails (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const type = ModelType.create("test/registered-nowhere");
    const id = crypto.randomUUID() as DefinitionId;
    const byId = join(autoDir, type.toDirectoryPath(), `${id}.yaml`);
    const { lookup, errors } = fakeUnreadableLookup([byId]);
    const { repo } = idIndexedRepository(dir, lookup);
    assertEquals(
      await assertRejects(() => repo.findById(type, id)),
      errors.get(byId),
    );
    assertEquals(
      await repo.findById(type, crypto.randomUUID() as DefinitionId),
      null,
    );
  });
});

Deno.test("YamlDefinitionRepository.delete: with an id index attached, removes an auto-definition stored under its name", async () => {
  await withTempDir(async (dir) => {
    const { repo, calls, autoDir } = idIndexedRepository(dir);
    const id = crypto.randomUUID() as DefinitionId;
    const path = join(autoDir, testType.toDirectoryPath(), "doomed.yaml");
    await writeYaml(path, id, "doomed", testType.normalized);

    await repo.delete(testType, id);

    assertEquals(await fileExists(path), false);
    assert(calls.lookups > 0);
  });
});

Deno.test("YamlDefinitionRepository.useIdIndex: refuses a second index", async () => {
  await withTempDir((dir) => {
    const { repo } = idIndexedRepository(dir);
    assertThrows(
      () => repo.useIdIndex({ findAllById: () => Promise.resolve([]) }),
      Error,
      "already has an id index",
    );
    return Promise.resolve();
  });
});

Deno.test("YamlDefinitionRepository.findByIdFromIndex: undefined without an index; with one, the first file in scan order, typed by what it declares, else its directory, and null when none declares the id", async () => {
  await withTempDir(async (dir) => {
    const plain = new YamlDefinitionRepository(dir);
    const { repo, autoDir, primaryDir } = idIndexedRepository(dir);
    const shared = crypto.randomUUID() as DefinitionId;
    const untyped = crypto.randomUUID() as DefinitionId;
    await writeYaml(
      join(autoDir, "test", "a", "auto.yaml"),
      shared,
      "auto",
      "test/a",
    );
    await writeYaml(
      join(primaryDir, "test", "b", "primary.yaml"),
      shared,
      "primary",
      "test/declared",
    );
    const untypedPath = join(autoDir, "test", "c", "untyped.yaml");
    await ensureDir(dirname(untypedPath));
    await Deno.writeTextFile(
      untypedPath,
      `id: ${untyped}\nname: untyped\nversion: 1\n`,
    );

    assertEquals(await plain.findByIdFromIndex(shared), undefined);

    const first = await repo.findByIdFromIndex(shared);
    assertEquals(first?.definition.name, "primary");
    assertEquals(first?.type.normalized, "test/declared");
    assertPathEquals(
      repo.getPath(ModelType.create("test/b"), shared),
      join(primaryDir, "test", "b", "primary.yaml"),
    );

    const fromDir = await repo.findByIdFromIndex(untyped);
    assertEquals(fromDir?.definition.name, "untyped");
    assertEquals(fromDir?.type.normalized, "test/c");

    assertEquals(
      await repo.findByIdFromIndex(crypto.randomUUID() as DefinitionId),
      null,
    );
  });
});

Deno.test("YamlDefinitionRepository.findByIdFromIndex: a miss still fails on an auto-definition stored under its id that the datastore could not materialise (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, ".swamp", "auto-definitions");
    const id = crypto.randomUUID() as DefinitionId;
    const byId = join(autoDir, "test", "registered-nowhere", `${id}.yaml`);
    const { lookup, errors } = fakeUnreadableLookup([byId]);
    const { repo } = idIndexedRepository(dir, lookup);
    assertEquals(
      await assertRejects(() => repo.findByIdFromIndex(id)),
      errors.get(byId),
    );
    assertEquals(
      await repo.findByIdFromIndex(crypto.randomUUID() as DefinitionId),
      null,
    );
  });
});
