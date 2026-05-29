// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Integration test for `doctor secrets`: exercises the real service against a
 * real on-disk repository and the real model registry. It plants a cleartext
 * sensitive global argument on disk the way a legacy or datastore-synced
 * definition would carry one (bypassing the at-rest guard, which only fires on
 * `save()`), then asserts the scan flags it without ever echoing the secret.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import {
  collect,
  createDoctorSecretsDeps,
  createLibSwampContext,
  doctorSecrets,
  type DoctorSecretsEvent,
} from "../src/libswamp/mod.ts";

const CLEARTEXT = "PLAINTEXT_SECRET_VALUE";
const VAULT_EXPR = "${{ vault.get('v', 'k') }}";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-doctor-secrets-" });
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

async function findYamlForId(dir: string, id: string): Promise<string> {
  for await (const entry of walk(dir, { exts: [".yaml"] })) {
    if (entry.isFile && entry.name === `${id}.yaml`) {
      return entry.path;
    }
  }
  throw new Error(`no yaml for id ${id} under ${dir}`);
}

Deno.test("doctor secrets: flags a planted cleartext sensitive arg on disk", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "models"));

    const typeName = `@test-doctor-secrets/creds-${
      crypto.randomUUID().slice(0, 8)
    }`;
    const modelType = ModelType.create(typeName);
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
      resources: {},
      methods: {},
    });

    const repo = new YamlDefinitionRepository(repoDir);

    // A clean definition (vault.get expression) is allowed through save() and
    // establishes the on-disk type directory layout.
    const clean = Definition.create({
      name: "clean-creds",
      type: modelType.normalized,
      globalArguments: { apiKey: VAULT_EXPR, region: "eu-west-1" },
    });
    await repo.save(modelType, clean);

    // Plant a definition holding a cleartext literal by writing the YAML
    // directly — the at-rest guard fires on save(), so a legacy or
    // datastore-synced file is exactly how such a value reaches disk.
    const typeDir = dirname(
      await findYamlForId(join(repoDir, "models"), clean.id),
    );
    const leakyId = crypto.randomUUID();
    await Deno.writeTextFile(
      join(typeDir, `${leakyId}.yaml`),
      stringifyYaml({
        id: leakyId,
        name: "leaky-creds",
        version: 1,
        type: modelType.normalized,
        tags: {},
        globalArguments: { apiKey: CLEARTEXT, region: "us-east-1" },
      }),
    );

    const deps = await createDoctorSecretsDeps(repoDir);
    const events = await collect<DoctorSecretsEvent>(
      doctorSecrets(createLibSwampContext(), deps),
    );

    const completed = events.find((e) => e.kind === "completed");
    if (!completed || completed.kind !== "completed") {
      throw new Error("expected a completed event");
    }
    const { data } = completed;

    assertEquals(data.scanned, 2);
    assertEquals(data.findings.length, 1);
    assertEquals(data.findings[0].definitionName, "leaky-creds");
    assertEquals(data.findings[0].leakedPaths, ["apiKey"]);
    assertEquals(data.findings[0].remediations[0].path, "apiKey");
    assertStringIncludes(
      data.findings[0].remediations[0].expression,
      "vault.get",
    );

    // The secret must never appear anywhere in the scan output.
    assertEquals(JSON.stringify(data).includes(CLEARTEXT), false);
  });
});

Deno.test("doctor secrets: also scans auto-definitions, not just models/", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "models"));

    const typeName = `@test-doctor-secrets/auto-${
      crypto.randomUUID().slice(0, 8)
    }`;
    const modelType = ModelType.create(typeName);
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
      resources: {},
      methods: {},
    });

    const repo = new YamlDefinitionRepository(repoDir);

    // Save a clean definition under models/ to discover the type's on-disk
    // directory layout (mirrored under the auto-definitions tree).
    const clean = Definition.create({
      name: "clean-creds",
      type: modelType.normalized,
      globalArguments: { apiKey: VAULT_EXPR, region: "eu-west-1" },
    });
    await repo.save(modelType, clean);
    const typeDirRel = relative(
      join(repoDir, "models"),
      dirname(await findYamlForId(join(repoDir, "models"), clean.id)),
    );

    // Plant a cleartext leak in .swamp/auto-definitions — the tree that holds
    // model/workflow-run auto-created definitions, which findAllGlobal() alone
    // does not walk.
    const autoTypeDir = join(
      repoDir,
      ".swamp",
      "auto-definitions",
      typeDirRel,
    );
    await ensureDir(autoTypeDir);
    const leakyId = crypto.randomUUID();
    await Deno.writeTextFile(
      join(autoTypeDir, `${leakyId}.yaml`),
      stringifyYaml({
        id: leakyId,
        name: "auto-leaky-creds",
        version: 1,
        type: modelType.normalized,
        tags: {},
        globalArguments: { apiKey: CLEARTEXT, region: "us-east-1" },
      }),
    );

    const deps = await createDoctorSecretsDeps(repoDir);
    const events = await collect<DoctorSecretsEvent>(
      doctorSecrets(createLibSwampContext(), deps),
    );
    const completed = events.find((e) => e.kind === "completed");
    if (!completed || completed.kind !== "completed") {
      throw new Error("expected a completed event");
    }
    const { data } = completed;

    // Both the clean models/ def and the leaky auto-definition were scanned.
    assertEquals(data.scanned, 2);
    assertEquals(data.findings.length, 1);
    assertEquals(data.findings[0].definitionName, "auto-leaky-creds");
    assertEquals(data.findings[0].leakedPaths, ["apiKey"]);
    assertEquals(JSON.stringify(data).includes(CLEARTEXT), false);
  });
});
