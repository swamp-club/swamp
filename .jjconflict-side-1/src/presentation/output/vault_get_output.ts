import type { OutputMode } from "./output.ts";

/**
 * Data structure for the vault get output.
 */
export interface VaultGetData {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
  storagePath: string;
}

/**
 * Renders the vault get output in either log or JSON mode.
 */
export function renderVaultGet(data: VaultGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
