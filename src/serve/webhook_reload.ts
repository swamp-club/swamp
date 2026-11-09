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
import {
  mergeWebhookRoutes,
  parseRouteFiles,
  type RefusedRouteFile,
  type RouteFileLoad,
  type ShadowedRouteFile,
  shadowedRouteFileMessage,
} from "./webhook_route_files.ts";

export interface WebhookReloadResult {
  readonly changed: number;
  readonly warnings: readonly string[];
  /** refused route files or routes directory; the other routes still applied */
  readonly errors: readonly string[];
}

export type WebhookUpdater = (
  configs: readonly WebhookConfigEntry[],
) => Promise<WebhookReloadResult>;

export const FLAG_ROUTES_WARNING =
  "Ignored the webhooks list in the serve config: routes come from --webhook " +
  "flags, which are fixed at startup. Move them to webhooks in the serve " +
  "config to change them with 'swamp serve reload', or restart serve.";

export interface WebhookRouteTableDeps {
  /** where operator routes come from; route files merge under either */
  readonly source: "config" | "flag";
  readonly parse: (
    configs: readonly WebhookConfigEntry[],
  ) => Promise<WebhookEndpoint[]>;
  /** the --webhook routes, parsed once at startup */
  readonly flagEndpoints?: readonly WebhookEndpoint[];
  readonly loadRouteFiles?: () => Promise<RouteFileLoad>;
}

export interface WebhookRouteTable {
  readonly endpoints: readonly WebhookEndpoint[];
  readonly refused: readonly RefusedRouteFile[];
  readonly shadowed: readonly ShadowedRouteFile[];
  /** the routes directory could not be used, so no file route loaded */
  readonly directoryError?: string;
}

/** operator routes parse all-or-nothing; route files are refused one at a time */
export async function buildWebhookRouteTable(
  deps: WebhookRouteTableDeps,
  configs: readonly WebhookConfigEntry[],
): Promise<WebhookRouteTable> {
  const operator: WebhookEndpoint[] = deps.source === "flag"
    ? (deps.flagEndpoints ?? []).map((e) => ({ ...e, source: "flag" }))
    : (configs.length > 0 ? await deps.parse(configs) : []).map((e) => ({
      ...e,
      source: "config",
    }));
  let load: RouteFileLoad = { files: [], refused: [] };
  let directoryError: string | undefined;
  if (deps.loadRouteFiles) {
    try {
      load = await deps.loadRouteFiles();
    } catch (error) {
      // a bad routes directory drops the file routes, never serve or the
      // operator routes
      directoryError = error instanceof Error ? error.message : String(error);
    }
  }
  const parsed = await parseRouteFiles(load.files, deps.parse);
  const { endpoints, shadowed } = mergeWebhookRoutes(
    operator,
    parsed.endpoints,
  );
  return {
    endpoints,
    refused: [...load.refused, ...parsed.refused],
    shadowed,
    ...(directoryError !== undefined ? { directoryError } : {}),
  };
}

export interface WebhookUpdaterDeps extends WebhookRouteTableDeps {
  readonly service: Pick<WebhookService, "updateEndpoints">;
}

export function createWebhookUpdater(deps: WebhookUpdaterDeps): WebhookUpdater {
  return async (configs) => {
    const table = await buildWebhookRouteTable(deps, configs);
    const changed = deps.service.updateEndpoints(table.endpoints);
    const warnings = [
      ...(deps.source === "flag" && configs.length > 0
        ? [FLAG_ROUTES_WARNING]
        : []),
      ...table.shadowed.map(shadowedRouteFileMessage),
    ];
    return {
      changed,
      warnings,
      errors: [
        ...(table.directoryError !== undefined ? [table.directoryError] : []),
        ...table.refused.map((refused) => refused.message),
      ],
    };
  };
}
