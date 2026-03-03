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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["vault", "list-keys"]);

/**
 * Data structure for the vault list-keys output.
 */
export interface VaultListKeysData {
  vaultName: string;
  vaultType: string;
  secretKeys: string[];
  count: number;
}

/**
 * Renders the vault list-keys output in either log or JSON mode.
 */
export function renderVaultListKeys(
  data: VaultListKeysData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger
      .info`Vault ${data.vaultName} (${data.vaultType}): ${data.count} key(s)`;
    for (const key of data.secretKeys) {
      logger.info`  - ${key}`;
    }
  }
}
