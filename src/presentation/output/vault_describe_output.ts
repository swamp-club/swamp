import type { OutputMode } from "./output.ts";
import type { VaultConfig } from "../../domain/vaults/vault_config.ts";

/**
 * Renders vault description in either log or JSON mode.
 */
export function renderVaultDescribe(
  config: VaultConfig,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(config.toData(), null, 2));
  } else {
    console.log(JSON.stringify(config.toData(), null, 2));
  }
}
