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
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { z } from "zod";
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
  findDefinitionsByIdGlobal,
  isPartialId,
  isUuid,
  matchByPartialId,
} from "./model_lookup.ts";
import { Definition, type DefinitionId } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { ModelType } from "./model_type.ts";
import { modelRegistry } from "./model.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { DefinitionIdIndex } from "../../infrastructure/persistence/definition_id_index.ts";
import "./models.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lookup-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("isUuid returns true for valid UUID v4", () => {
  assertEquals(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assertEquals(isUuid("6ba7b810-9dad-41d4-80b4-00c04fd430c8"), true);
  assertEquals(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d479"), true);
});

Deno.test("isUuid returns true for non-v4 UUID versions", () => {
  assertEquals(isUuid("550e8400-e29b-11d4-a716-446655440000"), true);
  assertEquals(isUuid("550e8400-e29b-31d4-a716-446655440000"), true);
  assertEquals(isUuid("de8ad612-90b7-56bc-82dc-ba90e425e6f6"), true);
  assertEquals(isUuid("01929b6e-f83d-7f32-8eb2-3a1f0b5e4c9d"), true);
});

Deno.test("isUuid is case insensitive", () => {
  assertEquals(isUuid("550E8400-E29B-41D4-A716-446655440000"), true);
  assertEquals(isUuid("550e8400-E29B-41d4-a716-446655440000"), true);
});

Deno.test("isUuid returns false for invalid UUIDs", () => {
  assertEquals(isUuid("hello"), false);
  assertEquals(isUuid("my-model-name"), false);

  assertEquals(isUuid("550e8400-e29b-41d4-a716-44665544000"), false);
  assertEquals(isUuid("550e8400-e29b-41d4-a716-4466554400000"), false);

  assertEquals(isUuid("550e8400e29b41d4a716446655440000"), false);

  assertEquals(isUuid("550e8400-e29b-01d4-a716-446655440000"), false);
  assertEquals(isUuid("550e8400-e29b-91d4-a716-446655440000"), false);

  assertEquals(isUuid("550e8400-e29b-41d4-0716-446655440000"), false);
  assertEquals(isUuid("550e8400-e29b-41d4-c716-446655440000"), false);
});

Deno.test("isUuid returns false for empty string", () => {
  assertEquals(isUuid(""), false);
});

Deno.test("isPartialId returns true for valid partial IDs (3+ hex chars)", () => {
  assertEquals(isPartialId("abc"), true);
  assertEquals(isPartialId("5ec"), true);
  assertEquals(isPartialId("5ece291"), true);
  assertEquals(isPartialId("5ece291a-46c0"), true);
});

Deno.test("isPartialId returns true for full UUIDs", () => {
  assertEquals(isPartialId("550e8400-e29b-41d4-a716-446655440000"), true);
});

Deno.test("isPartialId returns false for too short strings", () => {
  assertEquals(isPartialId("ab"), false);
  assertEquals(isPartialId("5"), false);
  assertEquals(isPartialId(""), false);
});

Deno.test("isPartialId returns false for non-hex characters", () => {
  assertEquals(isPartialId("xyz"), false);
  assertEquals(isPartialId("model-name"), false);
  assertEquals(isPartialId("5ec_test"), false);
});

Deno.test("isPartialId is case insensitive", () => {
  assertEquals(isPartialId("ABC"), true);
  assertEquals(isPartialId("5EC"), true);
  assertEquals(isPartialId("AbC"), true);
});

Deno.test("matchByPartialId returns found for single match", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(items, "5ec");
  assertEquals(result.status, "found");
  if (result.status === "found") {
    assertEquals(result.match, "item1");
  }
});

Deno.test("matchByPartialId returns not_found when no match", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(items, "999");
  assertEquals(result.status, "not_found");
});

Deno.test("matchByPartialId returns ambiguous when multiple matches", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "5ecf8b2c-1234-5678-9abc-def012345678", item: "item2" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item3" },
  ];

  const result = matchByPartialId(items, "5ec");
  assertEquals(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assertEquals(result.matches.length, 2);
    assertEquals(result.matches[0].id, "5ece291a-46c0-4fe2-8a1b-123456789abc");
    assertEquals(result.matches[1].id, "5ecf8b2c-1234-5678-9abc-def012345678");
  }
});

Deno.test("matchByPartialId is case insensitive", () => {
  const items = [
    { id: "5ECE291A-46C0-4FE2-8A1B-123456789ABC", item: "item1" },
  ];

  const result = matchByPartialId(items, "5ece");
  assertEquals(result.status, "found");
});

Deno.test("matchByPartialId ignores dashes in partial ID", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
  ];

  const result = matchByPartialId(items, "5ece-291a");
  assertEquals(result.status, "found");
});

Deno.test("matchByPartialId matches full UUID", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "5ecf8b2c-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(
    items,
    "5ece291a-46c0-4fe2-8a1b-123456789abc",
  );
  assertEquals(result.status, "found");
  if (result.status === "found") {
    assertEquals(result.match, "item1");
  }
});

Deno.test("findDefinitionByIdOrName finds definition by name", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    const definition = Definition.create({
      name: "my-model",
      version: 1,
      tags: {},
      globalArguments: { message: "hello" },
    });
    await repo.save(type, definition);

    const result = await findDefinitionByIdOrName(repo, "my-model");

    assertEquals(result?.definition.id, definition.id);
    assertEquals(result?.definition.name, "my-model");
    assertEquals(result?.type.normalized, "command/shell");
  });
});

Deno.test("findDefinitionByIdOrName finds definition by UUID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    const definition = Definition.create({
      name: "my-model",
      version: 1,
      tags: {},
      globalArguments: { message: "hello" },
    });
    await repo.save(type, definition);

    const result = await findDefinitionByIdOrName(repo, definition.id);

    assertEquals(result?.definition.id, definition.id);
    assertEquals(result?.definition.name, "my-model");
    assertEquals(result?.type.normalized, "command/shell");
  });
});

Deno.test("findDefinitionByIdGlobal reports a loaded definition's own type, not the first type tried", async () => {
  await withTempDir(async (dir) => {
    // Registered after the built-in types, so a lookup that trusted any
    // cached path would pair the definition with command/shell first.
    const type = ModelType.create(
      `test/lookup-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type,
      version: "2026.01.01.1",
      methods: {
        noop: {
          description: "noop",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
    });
    try {
      const repo = new YamlDefinitionRepository(dir);
      const definition = Definition.create({
        name: "late-type-model",
        globalArguments: {},
      });
      await repo.save(type, definition);
      await repo.findById(type, definition.id);

      const result = await findDefinitionByIdGlobal(repo, definition.id);

      assertEquals(result?.definition.id, definition.id);
      assertEquals(result?.type.normalized, type.normalized);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("findDefinitionByIdGlobal finds a definition whose type is not registered", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("test/unregistered-type");
    const definition = Definition.create({
      name: "orphan-model",
      globalArguments: {},
    });
    await repo.save(type, definition);

    const byName = await findDefinitionByIdOrName(repo, "orphan-model");
    const byId = await findDefinitionByIdGlobal(repo, definition.id);

    assertEquals(byName?.definition.id, definition.id);
    assertEquals(byId?.definition.id, definition.id);
    assertEquals(byId?.type.normalized, byName?.type.normalized);
  });
});

Deno.test("findDefinitionByIdGlobal reports the type a file declares, as the name lookup does", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    // Filed under command/shell but declaring another type, as a hand-edited
    // or synced file can be.
    const shell = ModelType.create("command/shell");
    const definition = Definition.create({
      name: "misfiled",
      globalArguments: {},
    });
    await repo.save(shell, definition);
    const path = repo.getPath(shell, definition.id);
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)).replace(
        "type: command/shell",
        "type: test/declared-type",
      ),
    );

    const byName = await findDefinitionByIdOrName(repo, "misfiled");
    const byId = await findDefinitionByIdGlobal(repo, definition.id);

    assertEquals(byName?.type.normalized, "test/declared-type");
    assertEquals(byId?.type.normalized, byName?.type.normalized);
  });
});

Deno.test("findDefinitionByIdGlobal finds an auto-definition of an unregistered type", async () => {
  await withTempDir(async (dir) => {
    const autoDir = join(dir, "auto-definitions");
    const type = ModelType.create("test/unregistered-auto");
    const definition = Definition.create({
      name: "auto-orphan",
      globalArguments: {},
    });
    await new YamlDefinitionRepository(dir, undefined, autoDir, false).save(
      type,
      definition,
    );
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      autoDir,
    );

    const byName = await findDefinitionByIdOrName(repo, "auto-orphan");
    const byId = await findDefinitionByIdGlobal(repo, definition.id);

    assertEquals(byName?.definition.id, definition.id);
    assertEquals(byId?.definition.id, definition.id);
    assertEquals(byId?.type.normalized, byName?.type.normalized);
  });
});

Deno.test("findDefinitionByIdGlobal answers a definition just found by name without scanning type directories", async () => {
  await withTempDir(async (dir) => {
    // Registered after the built-in types, so an uncached lookup would scan
    // every earlier type's directory first.
    const type = ModelType.create(
      `test/late-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type,
      version: "2026.01.01.1",
      methods: {
        noop: {
          description: "noop",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
    });
    try {
      const repo = new YamlDefinitionRepository(dir);
      for (let i = 0; i < 5; i++) {
        await repo.save(
          ModelType.create("command/shell"),
          Definition.create({ name: `shell-${i}`, globalArguments: {} }),
        );
      }
      const definition = Definition.create({
        name: "late-model",
        globalArguments: {},
      });
      await repo.save(type, definition);
      await findDefinitionByIdOrName(repo, "late-model");

      const scanned: string[] = [];
      const findAll = repo.findAll.bind(repo);
      repo.findAll = (t) => {
        scanned.push(t.normalized);
        return findAll(t);
      };
      const byId = await findDefinitionByIdGlobal(repo, definition.id);
      const otherType = await repo.findById(
        ModelType.create("command/shell"),
        definition.id,
      );

      assertEquals(byId?.definition.id, definition.id);
      assertEquals(byId?.type.normalized, type.normalized);
      assertEquals(otherType, null);
      assertEquals(scanned, []);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("findDefinitionByIdGlobal with an expected name accepts only the definition with both the id and the name", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const shell = ModelType.create("command/shell");
    const prod = Definition.create({ name: "prod-db", globalArguments: {} });
    await repo.save(shell, prod);
    const path = repo.getPath(shell, prod.id);
    await Deno.writeTextFile(
      join(dir, "models", shell.toDirectoryPath(), "safe-model.yaml"),
      (await Deno.readTextFile(path)).replace(
        "name: prod-db",
        "name: safe-model",
      ),
    );
    await repo.findByNameGlobal("safe-model");
    await repo.findByNameGlobal("prod-db");

    assertEquals(
      (await findDefinitionByIdGlobal(repo, prod.id, "safe-model"))?.definition
        .name,
      "safe-model",
    );
    assertEquals(
      (await findDefinitionByIdGlobal(repo, prod.id, "prod-db"))?.definition
        .name,
      "prod-db",
    );
    assertEquals(await findDefinitionByIdGlobal(repo, prod.id, "other"), null);
  });
});

Deno.test("findDefinitionByIdGlobal returns null for a non-UUID without scanning", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    await repo.save(
      ModelType.create("command/shell"),
      Definition.create({ name: "not-an-id", globalArguments: {} }),
    );
    assertEquals(await findDefinitionByIdGlobal(repo, "not-an-id"), null);
  });
});

Deno.test("findDefinitionByIdOrName returns null when not found", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);

    const result = await findDefinitionByIdOrName(repo, "nonexistent");

    assertEquals(result, null);
  });
});

Deno.test("findDefinitionByIdOrName prefers name match over ID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");

    const def1 = Definition.create({
      name: "abc123",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    const def2 = Definition.create({
      name: "other-model",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    await repo.save(type, def1);
    await repo.save(type, def2);

    const result = await findDefinitionByIdOrName(repo, "abc123");

    assertEquals(result?.definition.name, "abc123");
  });
});

// a non-UUID string can never match by id, so the id fallback must not re-parse
// every definition per model type; reads are counted, never timed
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

Deno.test("findDefinitionByIdOrName skips the ID scan for a non-UUID miss", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    for (let i = 0; i < 5; i++) {
      await repo.save(type, Definition.create({ name: `resident-${i}` }));
    }

    const [result, reads] = await countingReads(() =>
      findDefinitionByIdOrName(repo, "missing-model-name")
    );

    assertEquals(result, null);
    assertEquals(reads <= 5, true);
  });
});

Deno.test("findDefinitionByIdOrName still scans by ID for a UUID miss", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    await repo.save(type, Definition.create({ name: "resident" }));

    const result = await findDefinitionByIdOrName(
      repo,
      "550e8400-e29b-41d4-a716-446655440000",
    );

    assertEquals(result, null);
  });
});

Deno.test("findDefinitionByIdOrName still resolves a definition by its UUID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    const definition = Definition.create({ name: "findable" });
    await repo.save(type, definition);

    const result = await findDefinitionByIdOrName(repo, definition.id);

    assertEquals(result?.definition.id, definition.id);
    assertEquals(result?.type.normalized, type.normalized);
  });
});

Deno.test("findDefinitionsByIdGlobal: without a repository all-by-id lookup, filters every definition", async () => {
  const type = ModelType.create("test/lookup");
  const id = crypto.randomUUID();
  const a = Definition.create({ id, name: "a", globalArguments: {} });
  const b = Definition.create({ id, name: "b", globalArguments: {} });
  const other = Definition.create({ name: "other", globalArguments: {} });
  const repo = {
    findAllGlobal: () =>
      Promise.resolve(
        [a, b, other].map((definition) => ({ definition, type })),
      ),
  } as unknown as DefinitionRepository;
  const found = await findDefinitionsByIdGlobal(repo, id);
  assertEquals(found.map((entry) => entry.definition.name), ["a", "b"]);
});

Deno.test("findDefinitionsByIdGlobal: a string that is not a UUID matches nothing, without a scan", async () => {
  const repo = {
    findAllGlobal: () => Promise.reject(new Error("must not scan")),
    findAllByIdGlobal: () => Promise.reject(new Error("must not scan")),
  } as unknown as DefinitionRepository;
  assertEquals(await findDefinitionsByIdGlobal(repo, "prod-db"), []);
});

function indexedRepository(dir: string) {
  const repo = new YamlDefinitionRepository(dir);
  const index = new DefinitionIdIndex(repo);
  repo.useNameIndex(index);
  repo.useIdIndex(index);
  const calls: string[] = [];
  const findById = repo.findById.bind(repo);
  repo.findById = (type, id) => {
    calls.push(`findById:${type.normalized}`);
    return findById(type, id);
  };
  const findByNameGlobal = repo.findByNameGlobal.bind(repo);
  repo.findByNameGlobal = (name) => {
    calls.push("findByNameGlobal");
    return findByNameGlobal(name);
  };
  const fromIndex = repo.findByNameGlobalFromIndex.bind(repo);
  repo.findByNameGlobalFromIndex = (name) => {
    calls.push("findByNameGlobalFromIndex");
    return fromIndex(name);
  };
  return { repo, calls };
}

async function writeDefinitionFile(
  path: string,
  id: string,
  name: string,
  type?: string,
): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(
    path,
    (type ? `type: ${type}\n` : "") + `id: ${id}\nname: ${name}\nversion: 1\n`,
  );
}

Deno.test("findDefinitionByIdGlobal: with a definition index, an auto-definition stored under its name is found without a lookup per registered type", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await writeDefinitionFile(
      join(dir, ".swamp", "auto-definitions", "command", "shell", "x-1.yaml"),
      id,
      "x-1",
      "command/shell",
    );
    const { repo, calls } = indexedRepository(dir);

    const found = await findDefinitionByIdGlobal(repo, id);

    assertEquals(found?.definition.name, "x-1");
    assertEquals(found?.type.normalized, "command/shell");
    assertEquals(calls, []);
  });
});

Deno.test("findDefinitionByIdGlobal: with a definition index, a copied id resolves to the first file in scan order, as findByIdGlobal does", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await writeDefinitionFile(
      join(dir, "models", "command", "shell", "copy.yaml"),
      id,
      "copy",
      "command/shell",
    );
    await writeDefinitionFile(
      join(dir, "models", "aws", "ec2", "original.yaml"),
      id,
      "original",
      "aws/ec2",
    );
    const { repo } = indexedRepository(dir);
    const walked = new YamlDefinitionRepository(dir);

    const found = await findDefinitionByIdGlobal(repo, id);
    const scanned = await walked.findByIdGlobal(id as DefinitionId);

    assertEquals(found?.definition.name, scanned?.definition.name);
    assertEquals(found?.type.normalized, scanned?.type.normalized);
  });
});

Deno.test("findDefinitionByIdGlobal: without a definition index, falls back to a lookup per registered type", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await writeDefinitionFile(
      join(dir, ".swamp", "auto-definitions", "command", "shell", "x-1.yaml"),
      id,
      "x-1",
      "command/shell",
    );
    const repo = new YamlDefinitionRepository(dir);
    let lookups = 0;
    const findById = repo.findById.bind(repo);
    repo.findById = (type, defId) => {
      lookups++;
      return findById(type, defId);
    };

    const found = await findDefinitionByIdGlobal(repo, id);

    assertEquals(found?.definition.name, "x-1");
    assertEquals(lookups > 0, true);
  });
});

Deno.test("findDefinitionByIdGlobal: with an expected name, looks the name up through the definition index and still rejects another id", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await writeDefinitionFile(
      join(dir, ".swamp", "auto-definitions", "command", "shell", "x-1.yaml"),
      id,
      "x-1",
      "command/shell",
    );
    const { repo, calls } = indexedRepository(dir);

    assertEquals(
      (await findDefinitionByIdGlobal(repo, id, "x-1"))?.definition.name,
      "x-1",
    );
    assertEquals(
      await findDefinitionByIdGlobal(repo, crypto.randomUUID(), "x-1"),
      null,
    );
    assertEquals(calls, [
      "findByNameGlobalFromIndex",
      "findByNameGlobalFromIndex",
    ]);
  });
});

Deno.test("findDefinitionByIdOrName: a UUID is tried as a name through the definition index; any other name keeps the walk", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await writeDefinitionFile(
      join(dir, ".swamp", "auto-definitions", "command", "shell", "x-1.yaml"),
      id,
      "x-1",
      "command/shell",
    );
    const { repo, calls } = indexedRepository(dir);

    assertEquals(
      (await findDefinitionByIdOrName(repo, id))?.definition.name,
      "x-1",
    );
    assertEquals(calls, ["findByNameGlobalFromIndex"]);

    calls.length = 0;
    assertEquals(
      (await findDefinitionByIdOrName(repo, "x-1"))?.definition.id,
      id as DefinitionId,
    );
    assertEquals(calls, ["findByNameGlobal"]);
  });
});

Deno.test("findDefinitionByIdOrName: a definition named with a UUID still wins over the definition with that id", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await writeDefinitionFile(
      join(dir, "models", "command", "shell", "by-id.yaml"),
      id,
      "by-id",
      "command/shell",
    );
    await writeDefinitionFile(
      join(dir, "models", "command", "shell", `${id}.yaml`),
      crypto.randomUUID(),
      id,
      "command/shell",
    );
    const { repo } = indexedRepository(dir);

    assertEquals(
      (await findDefinitionByIdOrName(repo, id))?.definition.name,
      id,
    );
  });
});

Deno.test("findDefinitionByIdGlobal: with a definition index, a miss is final, with no lookup per registered type and no walk", async () => {
  await withTempDir(async (dir) => {
    await writeDefinitionFile(
      join(dir, ".swamp", "auto-definitions", "command", "shell", "x-1.yaml"),
      crypto.randomUUID(),
      "x-1",
      "command/shell",
    );
    const { repo, calls } = indexedRepository(dir);
    let walks = 0;
    const findByIdGlobal = repo.findByIdGlobal.bind(repo);
    repo.findByIdGlobal = (id) => {
      walks++;
      return findByIdGlobal(id);
    };

    assertEquals(
      await findDefinitionByIdGlobal(repo, crypto.randomUUID()),
      null,
    );
    assertEquals(calls, []);
    assertEquals(walks, 0);
  });
});
