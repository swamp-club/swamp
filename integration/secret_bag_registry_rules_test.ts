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

// Architectural fitness test: one sentinel registry per run (typed-secrets
// Section 3.2, swamp-club#3558).
//
// Every VaultSecretBag is a view of its run's SecretBagRegistry, carried by
// RunSensitiveValues, so a sentinel issued in any pass resolves from any
// step's bag. A bag over a registry of its own breaks that silently: a
// sentinel from an earlier pass would be delivered as literal text. The
// constructor requires a registry, so the places that create one are the
// whole story, and they are pinned here.
//
// A vault.get() value is read only at delivery (typed-secrets Section 3.3,
// swamp-club#3562): the SecretLoader is the one place that reads a value for
// delivery and builds the delivery view that holds it, so a new read path
// cannot fill a bag before delivery, or around the loader's access scope and
// redaction.

import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/**
 * Where a registry may be created outside tests:
 * - the run's record of sensitive values, which every run creates once;
 * - independent nested invocations, through SecretBagRegistry.independent;
 * - a worker rebuilding a dispatched bag, which is that worker's whole run;
 * - the evaluation service's fallback for callers with no run context (the
 *   validate pre-flight checks).
 */
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

/** Production files whose code, comments aside, matches `pattern`. */
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
