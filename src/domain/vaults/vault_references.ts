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
 * Where a vault is named by the repository's definitions, workflows and
 * datastore config, so `swamp vault remove` can refuse to remove a vault
 * something still uses (swamp-club#3597).
 *
 * @module
 */

import type { Definition } from "../definitions/definition.ts";
import type { Workflow } from "../workflows/workflow.ts";
import { scanExpressions } from "../expressions/expression_scanner.ts";
import {
  findVaultGetCalls,
  isDynamicVaultArgument,
} from "../expressions/vault_reference_extractor.ts";

/** What names the vault. */
export type VaultReferenceSourceKind = "definition" | "workflow" | "datastore";

/** How the source names the vault. */
export type VaultReferenceVia =
  | "vault.get"
  | "resource override"
  | "vaults list";

/** One place that names the vault. */
export interface VaultReferenceSite {
  kind: VaultReferenceSourceKind;
  /** The definition or workflow name; `datastore` for the datastore config. */
  name: string;
  via: VaultReferenceVia;
}

/** A source whose `vault.get` names its vault only when evaluated. */
export interface PossibleVaultReference {
  kind: VaultReferenceSourceKind;
  name: string;
}

/** Everything that names the vault, and everything that may. */
export interface VaultReferences {
  references: VaultReferenceSite[];
  possibleReferences: PossibleVaultReference[];
}

/** The sources a vault may be named in. */
export interface VaultReferenceSources {
  definitions: readonly Definition[];
  workflows: readonly Workflow[];
  /** The repo marker's datastore config, whose strings may call `vault.get`. */
  datastoreConfig?: unknown;
}

/**
 * Finds every place that names `vaultName`: a `vault.get` call whose vault
 * argument is the name, a definition's resource override `vaultName`, or a
 * workflow's `vaults` allow-list. A `vault.get` whose vault argument is evaluated (`inputs.v`)
 * cannot be resolved here, so its source is a possible reference instead.
 */
export function findVaultReferences(
  vaultName: string,
  sources: VaultReferenceSources,
): VaultReferences {
  const references: VaultReferenceSite[] = [];
  const possibleReferences: PossibleVaultReference[] = [];

  const scan = (
    kind: VaultReferenceSourceKind,
    name: string,
    data: unknown,
  ) => {
    const calls = scanVaultGetCalls(vaultName, data);
    if (calls.named) references.push({ kind, name, via: "vault.get" });
    else if (calls.dynamic) possibleReferences.push({ kind, name });
  };

  for (const definition of sources.definitions) {
    scan("definition", definition.name, definition.toData());
    const overrides = Object.values(definition.resources ?? {});
    if (overrides.some((o) => o.vaultName === vaultName)) {
      references.push({
        kind: "definition",
        name: definition.name,
        via: "resource override",
      });
    }
  }

  // A step's data output override cannot name a vault yet: Step drops its
  // vaultName (swamp-club#3606).
  for (const workflow of sources.workflows) {
    scan("workflow", workflow.name, workflow.toData());
    if (workflow.vaults?.includes(vaultName)) {
      references.push({
        kind: "workflow",
        name: workflow.name,
        via: "vaults list",
      });
    }
  }

  if (sources.datastoreConfig !== undefined) {
    scan("datastore", "datastore", sources.datastoreConfig);
  }

  return { references, possibleReferences };
}

/**
 * Whether any `vault.get` call in `data` names `vaultName` as its vault, and
 * whether any names its vault only when evaluated.
 */
function scanVaultGetCalls(
  vaultName: string,
  data: unknown,
): { named: boolean; dynamic: boolean } {
  const found = { named: false, dynamic: false };
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const span of scanExpressions(value)) {
        for (const call of findVaultGetCalls(span.inner)) {
          // Groups: [2]=quoted vault, [3]=unquoted vault.
          const quoted = call[2];
          const bare = call[3];
          if (quoted !== undefined) {
            if (quoted === vaultName) found.named = true;
          } else if (bare !== undefined && isDynamicVaultArgument(bare)) {
            found.dynamic = true;
          } else if (bare === vaultName) {
            found.named = true;
          }
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(data);
  return found;
}
