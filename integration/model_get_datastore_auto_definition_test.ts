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

// `swamp model get` with a datastore configured: auto-definitions live in the
// datastore, and the command must find them there, as `model method run`
// does (swamp-club#3154).

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { modelGetCommand } from "../src/cli/commands/model_get.ts";
import { ModelNameType } from "../src/cli/completion_types.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

await initializeLogging({});

const shellType = ModelType.create("command/shell");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

/** A repo whose marker points at a filesystem datastore outside it. */
async function initDatastoreRepo(
  dir: string,
): Promise<{ repoDir: string; autoDefinitionsDir: string }> {
  const repoDir = join(dir, "repo");
  const datastore = { type: "filesystem" as const, path: join(dir, "ds") };
  await Deno.mkdir(join(repoDir, "models"), { recursive: true });
  await new RepoMarkerRepository().write(RepoPath.create(repoDir), {
    swampVersion: "0.1.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    repoId: crypto.randomUUID(),
    tools: [],
    datastore,
  });
  const autoDefinitionsDir = new DefaultDatastorePathResolver(
    repoDir,
    datastore,
  ).resolvePath(SWAMP_SUBDIRS.autoDefinitions);
  return { repoDir, autoDefinitionsDir };
}

async function saveDefinition(
  repo: YamlDefinitionRepository,
  name: string,
): Promise<Definition> {
  const definition = Definition.create({
    name,
    type: shellType.normalized,
    globalArguments: {},
  });
  await repo.save(shellType, definition);
  return definition;
}

/**
 * Runs `model get --json` in-process and returns the printed definition.
 * Captures the JSON by swapping the process-global console.log, which holds
 * only because Deno runs the tests in a file one at a time.
 */
async function modelGetJson(
  repoDir: string,
  modelIdOrName: string,
): Promise<{ id: string; name: string; autoCreated?: boolean }> {
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    await new Command()
      .globalOption("--json", "JSON output")
      .globalType("model_name", new ModelNameType())
      .command("get", modelGetCommand)
      .parse(["get", modelIdOrName, "--repo-dir", repoDir, "--json"]);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(printed.join("\n"));
}

Deno.test({
  name:
    "model get: finds an auto-definition stored in the datastore, by name and by id (swamp-club#3154)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const { repoDir, autoDefinitionsDir } = await initDatastoreRepo(dir);
      const auto = await saveDefinition(
        new YamlDefinitionRepository(
          repoDir,
          undefined,
          autoDefinitionsDir,
          false,
        ),
        "hello",
      );

      for (const ref of [auto.name, auto.id]) {
        const got = await modelGetJson(repoDir, ref);
        assertEquals(got.id, auto.id);
        assertEquals(got.name, "hello");
        assertEquals(got.autoCreated, true);
      }
    });
  },
});

Deno.test({
  name:
    "model get: a models/ definition is not flagged auto-created when a datastore is configured (swamp-club#3154)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const { repoDir } = await initDatastoreRepo(dir);
      const authored = await saveDefinition(
        new YamlDefinitionRepository(repoDir),
        "authored",
      );

      const got = await modelGetJson(repoDir, "authored");
      assertEquals(got.id, authored.id);
      assertEquals(got.autoCreated, undefined);
    });
  },
});
