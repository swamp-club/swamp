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

import type { WebhookConfigEntry } from "./serve_config.ts";
import type { WebhookEndpoint, WebhookService } from "./webhook.ts";

/** Where a serve's webhook routes come from; flags replace the file list. */
export type WebhookRouteSource = "config" | "flag";

export interface WebhookReloadResult {
  readonly changed: number;
  readonly warnings: readonly string[];
}

export type WebhookUpdater = (
  configs: readonly WebhookConfigEntry[],
) => Promise<WebhookReloadResult>;

export const FLAG_ROUTES_WARNING =
  "Ignored the webhooks list in the serve config: routes come from --webhook " +
  "flags, which are fixed at startup. Move them to webhooks in the serve " +
  "config to change them with 'swamp serve reload', or restart serve.";

export interface WebhookUpdaterDeps {
  readonly source: WebhookRouteSource;
  readonly service: Pick<WebhookService, "updateEndpoints">;
  readonly parse: (
    configs: readonly WebhookConfigEntry[],
  ) => Promise<WebhookEndpoint[]>;
}

/** Applies a re-read webhooks list, or warns when flags own the routes. */
export function createWebhookUpdater(deps: WebhookUpdaterDeps): WebhookUpdater {
  return async (configs) => {
    if (deps.source === "flag") {
      return {
        changed: 0,
        warnings: configs.length > 0 ? [FLAG_ROUTES_WARNING] : [],
      };
    }
    const endpoints = configs.length > 0 ? await deps.parse(configs) : [];
    return { changed: deps.service.updateEndpoints(endpoints), warnings: [] };
  };
}
