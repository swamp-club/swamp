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

// one sentinel registry per run: every bag views its run's registry, and a
// vault.get value is read only at delivery by SecretLoader; the places that
// create either are pinned

import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const REGISTRY_CREATORS = [
  "src/domain/expressions/expression_evaluation_service.ts",
  "src/domain/secrets/run_sensitive_values.ts",
  "src/domain/vaults/secret_bag_registry.ts",
  "src/domain/vaults/vault_secret_bag.ts",
];

Deno.test("secret bag registry: only the pinned production files create a registry", async () => {
  const creators: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    const code = source.split("\n").filter((line) => !isCommentLine(line))
      .join("\n");
    if (/\bnew SecretBagRegistry\(\)/.test(code)) {
      creators.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    creators.sort(),
    REGISTRY_CREATORS,
    "SecretBagRegistry creation sites",
    "A bag must be a view of its run's registry: build it with " +
      "new VaultSecretBag(sensitiveValues.sentinels) from the run's " +
      "RunSensitiveValues (or sensitiveValuesOf(context)). Create a " +
      "registry only where a run begins, and add that file here with its " +
      "reason.",
  );
});

async function filesMatching(pattern: RegExp): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    const code = source.split("\n").filter((line) => !isCommentLine(line))
      .join("\n");
    if (pattern.test(code)) files.push(repoRelative(filePath));
  }
  return files.sort();
}

const LOADER = ["src/domain/vaults/secret_loader.ts"];

Deno.test("secret bag registry: only the secret loader builds a delivery view", async () => {
  assertPinnedSet(
    await filesMatching(/\.withLoaded\(/),
    LOADER,
    "VaultSecretBag.withLoaded call sites",
    "A delivery view holds plaintext: build one only through " +
      "SecretLoader.load at the delivery that receives it.",
  );
});

Deno.test("secret bag registry: only the secret loader reads a vault.get value for delivery", async () => {
  assertPinnedSet(
    await filesMatching(/"expression:vault-resolve"/),
    LOADER,
    "Reads with the load purpose",
    "Read a vault.get() value only through SecretLoader.load, which runs " +
      "under the run's vault access and registers the value with the " +
      "redactor; the existence check reads with PROBE_PURPOSE.",
  );
});
