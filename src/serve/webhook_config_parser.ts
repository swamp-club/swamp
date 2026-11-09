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

import { parseWebhookConfig, type WebhookConfigEntry } from "./serve_config.ts";
import {
  resolveExtensionWebhookEndpoints,
  type VaultSecretResolver,
  type WebhookEndpoint,
  WebhookEnvironmentError,
} from "./webhook.ts";

export interface WebhookConfigParserDeps {
  /** opened on every parse, so a reload sees vault configuration changes */
  readonly openVaults: () => Promise<VaultSecretResolver>;
  readonly resolveType: (type: string) => Promise<boolean>;
}

/** all entries parse or the call throws; route files call it one entry at a time */
export function createWebhookConfigParser(
  deps: WebhookConfigParserDeps,
): (configs: readonly WebhookConfigEntry[]) => Promise<WebhookEndpoint[]> {
  return async (configs) => {
    let vaults: VaultSecretResolver;
    try {
      vaults = await deps.openVaults();
    } catch (cause) {
      throw new WebhookEnvironmentError(
        `Failed to open the repository's vaults for webhook secrets: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
    const parsed = await Promise.all(
      configs.map((entry) => parseWebhookConfig(entry, vaults)),
    );
    return await resolveExtensionWebhookEndpoints(parsed, deps.resolveType);
  };
}
