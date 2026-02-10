import type { OutputMode } from "./output.ts";
import type { VaultTypeSearchItem } from "./vault_type_search_output.tsx";

/**
 * Renders vault type description in either log or JSON mode.
 */
export function renderVaultTypeDescribe(
  data: VaultTypeSearchItem,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
