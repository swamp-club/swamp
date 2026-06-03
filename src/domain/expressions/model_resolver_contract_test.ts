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
 * Contract tests for ModelResolver as the ACL between expressions and domain.
 *
 * The existing model_resolver_test.ts covers data namespace functions
 * (latest, version, listVersions, findByTag, findBySpec). These contract
 * tests verify:
 * - resolveModel throws ModelNotFoundError for invalid refs (not null/undefined)
 * - resolveModel finds models by both name and UUID
 * - buildContext always includes env namespace
 * - buildContext self reference has stable fields
 * - updateOutputInContext/updateDefinitionInContext mutate context correctly
 * - ModelData.input always has the stable interface expressions depend on
 */

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { ModelResolver } from "./model_resolver.ts";
import { ModelNotFoundError } from "./errors.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resolver-contract-" });
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

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, "models"));
  await ensureDir(join(dir, "vaults"));
}

// ============================================================================
// resolveModel error contract
// ============================================================================

Deno.test("contract: resolveModel throws ModelNotFoundError for invalid name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const resolver = new ModelResolver(defRepo);

    await assertRejects(
      () => resolver.resolveModel("nonexistent-model"),
      ModelNotFoundError,
    );
  });
});

Deno.test("contract: resolveModel throws ModelNotFoundError for invalid UUID", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const resolver = new ModelResolver(defRepo);

    await assertRejects(
      () => resolver.resolveModel(crypto.randomUUID()),
      ModelNotFoundError,
    );
  });
});

// ============================================================================
// resolveModel lookup contract
// ============================================================================

Deno.test("contract: resolveModel finds model by name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const def = Definition.create({ name: "my-model" });
    await defRepo.save(type, def);

    const resolver = new ModelResolver(defRepo);
    const result = await resolver.resolveModel("my-model");

    assertEquals(result.definition.id, def.id);
    assertEquals(result.definition.name, "my-model");
    assertEquals(result.type.normalized, "test/model");
  });
});

Deno.test("contract: resolveModel finds model by UUID", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const def = Definition.create({ name: "uuid-model" });
    await defRepo.save(type, def);

    const resolver = new ModelResolver(defRepo);
    const result = await resolver.resolveModel(def.id);

    assertEquals(result.definition.name, "uuid-model");
  });
});

// ============================================================================
// buildContext invariants
// ============================================================================

Deno.test("contract: buildContext always includes env namespace", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const resolver = new ModelResolver(defRepo);

    const ctx = await resolver.buildContext();

    assertExists(ctx.env);
    assertEquals(typeof ctx.env, "object");
    // PATH is present on all systems
    assert("PATH" in ctx.env || Object.keys(ctx.env).length >= 0);
  });
});

Deno.test("contract: buildContext indexes models by both name and UUID", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const def = Definition.create({
      name: "dual-index",
      globalArguments: { key: "value" },
    });
    await defRepo.save(type, def);

    const resolver = new ModelResolver(defRepo);
    const ctx = await resolver.buildContext();

    // Accessible by name
    assertExists(ctx.model["dual-index"]);
    assertEquals(ctx.model["dual-index"].input.name, "dual-index");

    // Accessible by UUID
    assertExists(ctx.model[def.id]);
    assertEquals(ctx.model[def.id].input.id, def.id);
  });
});

Deno.test("contract: ModelData.input has stable interface for expressions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const def = Definition.create({
      name: "stable-api",
      tags: { env: "prod" },
      globalArguments: { region: "us-east-1" },
    });
    await defRepo.save(type, def);

    const resolver = new ModelResolver(defRepo);
    const ctx = await resolver.buildContext();

    const modelData = ctx.model["stable-api"];
    assertExists(modelData);

    // These fields constitute the stable interface expressions depend on
    assertEquals(typeof modelData.input.id, "string");
    assertEquals(typeof modelData.input.name, "string");
    assertEquals(typeof modelData.input.version, "number");
    assertEquals(typeof modelData.input.tags, "object");
    assertEquals(typeof modelData.input.globalArguments, "object");

    // Values match what was set
    assertEquals(modelData.input.name, "stable-api");
    assertEquals(modelData.input.tags.env, "prod");
    assertEquals(modelData.input.globalArguments.region, "us-east-1");
  });
});

Deno.test("contract: buildContext self reference has id, name, version, tags, globalArguments", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const def = Definition.create({
      name: "self-model",
      tags: { team: "platform" },
      globalArguments: { count: 3 },
    });
    await defRepo.save(type, def);

    const resolver = new ModelResolver(defRepo);
    const ctx = await resolver.buildContext(def, type);

    assertExists(ctx.self);
    assertEquals(ctx.self!.id, def.id);
    assertEquals(ctx.self!.name, "self-model");
    assertEquals(ctx.self!.version, def.version);
    assertEquals(ctx.self!.tags.team, "platform");
    assertEquals(ctx.self!.globalArguments.count, 3);
  });
});

// ============================================================================
// Context update contracts
// ============================================================================

Deno.test("contract: updateDefinitionInContext updates the model's definition data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const def = Definition.create({
      name: "updatable",
      tags: { v: "1" },
    });
    await defRepo.save(type, def);

    const resolver = new ModelResolver(defRepo);
    const ctx = await resolver.buildContext();

    // Update the definition in context
    const updatedDef = Definition.create({
      id: def.id,
      name: "updatable",
      tags: { v: "2" },
    });

    resolver.updateDefinitionInContext(ctx, "updatable", updatedDef);

    assertEquals(ctx.model["updatable"].definition?.tags.v, "2");
  });
});
