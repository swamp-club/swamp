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

import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

/** Data payload for the completed event. */
export interface VaultListKeysData {
  vaultName: string;
  vaultType: string;
  secretKeys: string[];
  count: number;
}

export type VaultListKeysEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultListKeysData }
  | { kind: "error"; error: SwampError };

export interface VaultListKeysInput {
  vaultName: string;
}

/** Vault config info returned by find operations. */
interface VaultConfig {
  name: string;
  type: string;
}

/** Dependencies for the vault list-keys operation. */
export interface VaultListKeysDeps {
  findVaultByName: (name: string) => Promise<VaultConfig | null>;
  findAllVaults: () => Promise<VaultConfig[]>;
  listKeys: (vaultName: string) => Promise<string[]>;
}

/** Yields all secret key names in a vault. */
export async function* vaultListKeys(
  _ctx: LibSwampContext,
  deps: VaultListKeysDeps,
  input: VaultListKeysInput,
): AsyncIterable<VaultListKeysEvent> {
  yield { kind: "resolving" };

  if (!input.vaultName) {
    yield {
      kind: "error",
      error: validationFailed(
        "Missing required argument: vault_name\n\n" +
          "Usage: swamp vault list-keys <vault_name>\n\n" +
          "Use 'swamp vault search' to see available vaults.",
      ),
    };
    return;
  }

  const vaultConfig = await deps.findVaultByName(input.vaultName);
  if (!vaultConfig) {
    const allVaults = await deps.findAllVaults();
    if (allVaults.length === 0) {
      yield {
        kind: "error",
        error: notFound(
          "Vault",
          `'${input.vaultName}'. No vaults are configured.\n` +
            `Create a vault using: swamp vault create <type> ${input.vaultName}`,
        ),
      };
    } else {
      const vaultNames = allVaults.map((v) => v.name).join(", ");
      yield {
        kind: "error",
        error: notFound(
          "Vault",
          `'${input.vaultName}'. Available vaults: ${vaultNames}`,
        ),
      };
    }
    return;
  }

  const secretKeys = await deps.listKeys(input.vaultName);

  yield {
    kind: "completed",
    data: {
      vaultName: input.vaultName,
      vaultType: vaultConfig.type,
      secretKeys,
      count: secretKeys.length,
    },
  };
}
