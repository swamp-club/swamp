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
 * Integration tests for model evaluate persistence.
 *
 * Tests that `swamp model evaluate` persists evaluated definitions
 * to `.swamp/definitions-evaluated/`, matching the behavior of
 * `swamp workflow evaluate`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-model-evaluate-" });
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

Deno.test("CLI: model evaluate persists single model to definitions-evaluated", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create a model definition with a CEL expression
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("command/shell");
    const definition = Definition.create({
      name: "eval-persist-test",
      globalArguments: { computed: "${{ 1 + 1 }}" },
      methods: { execute: { arguments: { run: "echo hello" } } },
    });
    await definitionRepo.save(modelType, definition);

    const result = await runCliCommand(
      [
        "model",
        "evaluate",
        "eval-persist-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // Check that evaluated definition was persisted
    const evaluatedPath = join(
      repoDir,
      ".swamp/definitions-evaluated/command/shell",
      `${definition.id}.yaml`,
    );
    assertEquals(
      existsSync(evaluatedPath),
      true,
      `Evaluated definition should be persisted at ${evaluatedPath}`,
    );

    // Verify the persisted content has evaluated expressions
    const content = await Deno.readTextFile(evaluatedPath);
    const evaluated = parseYaml(content) as Record<string, unknown>;
    const globalArgs = evaluated.globalArguments as Record<string, unknown>;
    assertEquals(
      globalArgs.computed,
      2,
      "CEL expression should be evaluated to 2",
    );

    // Verify JSON output includes outputPath
    const output = JSON.parse(result.stdout);
    assertEquals(
      typeof output.outputPath,
      "string",
      "outputPath should be set",
    );
    assertStringIncludes(
      output.outputPath,
      "definitions-evaluated",
      "outputPath should point to definitions-evaluated directory",
    );
  });
});

Deno.test("CLI: model evaluate --all persists all models", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("command/shell");

    // Create multiple model definitions
    for (let i = 1; i <= 3; i++) {
      const definition = Definition.create({
        name: `eval-all-test-${i}`,
        methods: { execute: { arguments: { run: `echo model-${i}` } } },
      });
      await definitionRepo.save(modelType, definition);
    }

    const result = await runCliCommand(
      [
        "model",
        "evaluate",
        "--all",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assertEquals(output.total, 3, "Should have evaluated 3 models");

    // Verify all items have outputPath set
    for (const item of output.items) {
      assertEquals(
        typeof item.outputPath,
        "string",
        `outputPath should be set for ${item.name}`,
      );
    }

    // Verify files exist in definitions-evaluated
    const evaluatedDir = join(
      repoDir,
      ".swamp/definitions-evaluated/command/shell",
    );
    assertEquals(
      existsSync(evaluatedDir),
      true,
      "Evaluated definitions directory should exist",
    );
    const files = Array.from(Deno.readDirSync(evaluatedDir));
    assertEquals(files.length, 3, "Should have 3 evaluated definition files");
  });
});

Deno.test("CLI: model evaluate preserves vault expressions as raw strings", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("command/shell");
    const definition = Definition.create({
      name: "vault-preserve-test",
      globalArguments: {
        secret: "${{ vault.get('my-vault', 'api-key') }}",
      },
      methods: { execute: { arguments: { run: "echo secret" } } },
    });
    await definitionRepo.save(modelType, definition);

    const result = await runCliCommand(
      [
        "model",
        "evaluate",
        "vault-preserve-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // Read the persisted evaluated definition
    const evaluatedPath = join(
      repoDir,
      ".swamp/definitions-evaluated/command/shell",
      `${definition.id}.yaml`,
    );
    const content = await Deno.readTextFile(evaluatedPath);

    // Vault expression should still be present as raw string
    assertStringIncludes(
      content,
      "vault.get",
      "Vault expression should be preserved as raw string",
    );
  });
});
