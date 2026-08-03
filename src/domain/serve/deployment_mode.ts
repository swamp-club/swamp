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

export type DeploymentMode = "local" | "durable" | "durable (limited)";

export type DatastoreClassification =
  | { readonly kind: "filesystem" }
  | {
    readonly kind: "remote";
    readonly type: string;
    readonly hasControlPlane: boolean;
  };

export type VaultClassification =
  | { readonly kind: "none" }
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly type: string };

export interface DeploymentModeResult {
  readonly mode: DeploymentMode;
  readonly warnings: readonly string[];
}

export function resolveDeploymentMode(
  datastore: DatastoreClassification,
  vault: VaultClassification,
): DeploymentModeResult {
  if (datastore.kind === "filesystem") {
    return { mode: "local", warnings: [] };
  }

  if (!datastore.hasControlPlane) {
    return {
      mode: "local",
      warnings: [
        `Update ${datastore.type} for cross-machine durability`,
      ],
    };
  }

  const warnings: string[] = [];

  if (vault.kind === "none") {
    warnings.push(
      "No vault configured — workflows requiring secrets will fail after instance replacement",
    );
    return { mode: "durable", warnings };
  }

  if (vault.kind === "local") {
    warnings.push(
      "Vault is file-based — secrets will not be available after instance replacement",
    );
    return { mode: "durable (limited)", warnings };
  }

  return { mode: "durable", warnings: [] };
}
