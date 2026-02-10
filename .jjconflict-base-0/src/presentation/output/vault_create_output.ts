import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["vault", "create"]);

/**
 * Data for vault create output.
 */
export interface VaultCreateData {
  id: string;
  name: string;
  type: string;
  typeName: string;
  config: Record<string, unknown>;
}

/**
 * Renders vault create output in either log or JSON mode.
 */
export function renderVaultCreate(
  data: VaultCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Created vault: ${data.name} (${data.typeName})`;
  }
}
