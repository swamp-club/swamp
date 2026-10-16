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
 * - a worker rebuilding a dispatched bag, which is that worker's whole run;
 * - the evaluation service's fallback for callers with no run context (the
 *   validate pre-flight checks).
 */
const REGISTRY_CREATORS = [
  "src/domain/expressions/expression_evaluation_service.ts",
  "src/domain/secrets/run_sensitive_values.ts",
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
