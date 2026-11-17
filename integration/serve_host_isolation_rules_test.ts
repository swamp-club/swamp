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
import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  ROOT,
  staticImportClosure,
} from "./arch_fitness_helpers.ts";

const HOST_DIR = join(ROOT, "src", "serve", "host");
const HOST_COMMAND = "src/cli/commands/serve_host.ts";

const REGISTRIES = [
  "src/domain/models/model.ts",
  "src/domain/models/models.ts",
  "src/domain/vaults/vault_type_registry.ts",
  "src/domain/datastore/datastore_type_registry.ts",
];

// main.ts loads the registries anyway; this keeps the host's own code from
// depending on them, since the host runs no repo, extension or datastore
async function registryReaches(entry: string): Promise<string[]> {
  const closure = await staticImportClosure(entry);
  return REGISTRIES.filter((registry) => closure.has(registry))
    .map((registry) => `${entry} -> ${registry}`);
}

async function hostEntries(): Promise<string[]> {
  const entries = [HOST_COMMAND];
  for await (const path of productionSourceFiles(HOST_DIR)) {
    entries.push(repoRelative(path));
  }
  return entries.sort();
}

Deno.test("serve host isolation: no host module reaches the model, vault or datastore registries", async () => {
  const reaching: string[] = [];
  for (const entry of await hostEntries()) {
    reaching.push(...await registryReaches(entry));
  }
  assertPinnedSet(
    reaching,
    [],
    "serve host modules whose static import closure reaches a registry",
    "The host holds a listener and supervises serves; it loads no\n" +
      "extension, vault or datastore. Move what it needs out of the module\n" +
      "that pulls the registry in.",
  );
});

Deno.test("serve host isolation: the rule sees every registry and catches a module that imports one", async () => {
  for (const registry of REGISTRIES) {
    const stat = await Deno.stat(join(ROOT, registry));
    assert(stat.isFile, `${registry} exists`);
  }
  const entries = await hostEntries();
  assert(entries.includes("src/serve/host/supervisor.ts"));
  assert(entries.includes("src/serve/host/serve_host.ts"));
  assert(
    (await registryReaches("src/cli/commands/serve.ts")).includes(
      "src/cli/commands/serve.ts -> src/domain/vaults/vault_type_registry.ts",
    ),
    "serve.ts imports the vault type registry, so the check must report it",
  );
});
