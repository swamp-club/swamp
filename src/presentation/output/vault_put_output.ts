import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["vault", "put"]);

/**
 * Data structure for the vault put output.
 */
export interface VaultPutData {
  vaultName: string;
  secretKey: string;
  vaultType: string;
  overwritten: boolean;
  timestamp: string;
}

/**
 * Renders the vault put output in either log or JSON mode.
 */
export function renderVaultPut(data: VaultPutData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Stored secret ${data.secretKey} in vault ${data.vaultName}`;
  }
}

/**
 * Renders a cancellation message when user declines to overwrite.
 */
export function renderVaultPutCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    logger.info("Operation cancelled.");
  }
}
