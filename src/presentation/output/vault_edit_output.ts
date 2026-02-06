import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["vault", "edit"]);

/**
 * Data structure for vault edit output.
 */
export interface VaultEditData {
  path: string;
  editor: string;
  status: "opened";
  name: string;
  type: string;
}

/**
 * Renders vault edit output in either log or JSON mode.
 */
export function renderVaultEdit(data: VaultEditData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger
      .info`Opening vault config in ${data.editor}: ${data.name} (${data.type}) at ${data.path}`;
  }
}
