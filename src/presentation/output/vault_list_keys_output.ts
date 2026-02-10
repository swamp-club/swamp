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
