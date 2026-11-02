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

import type { Definition } from "../definitions/definition.ts";
import type { Workflow } from "../workflows/workflow.ts";
import { scanExpressions } from "./expression_scanner.ts";
import { vaultCallsForAnalysis } from "./vault_reference_extractor.ts";

export type VaultReferenceSourceKind = "definition" | "workflow" | "datastore";

export type VaultReferenceVia =
  | "vault.get"
  | "resource override"
  | "data output override"
  | "vaults list";

export interface VaultReferenceSite {
  kind: VaultReferenceSourceKind;
  name: string;
  via: VaultReferenceVia;
}

export interface PossibleVaultReference {
  kind: VaultReferenceSourceKind;
  name: string;
}

export interface VaultReferences {
  references: VaultReferenceSite[];
  possibleReferences: PossibleVaultReference[];
}

export interface VaultReferenceSources {
  definitions: readonly Definition[];
  workflows: readonly Workflow[];
  datastoreConfig?: unknown;
}

/**
 * a vault.get whose vault argument is evaluated (inputs.v) cannot be resolved
 * here, so its source is a possible reference instead
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

  for (const workflow of sources.workflows) {
    scan("workflow", workflow.name, workflow.toData());
    const stepOverrides = workflow.jobs.flatMap((job) =>
      job.steps.flatMap((step) => step.dataOutputOverrides)
    );
    if (stepOverrides.some((o) => o.vaultName === vaultName)) {
      references.push({
        kind: "workflow",
        name: workflow.name,
        via: "data output override",
      });
    }
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

function scanVaultGetCalls(
  vaultName: string,
  data: unknown,
): { named: boolean; dynamic: boolean } {
  const found = { named: false, dynamic: false };
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const span of scanExpressions(value)) {
        for (const call of vaultCallsForAnalysis(span.inner)) {
          const vault = call.args[0];
          if (vault.literal === vaultName) found.named = true;
          else if (vault.literal === undefined) found.dynamic = true;
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
