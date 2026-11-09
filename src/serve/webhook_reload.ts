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
import {
  diffWebhookEndpoints,
  type WebhookEndpoint,
  type WebhookEndpointDiff,
  webhookEndpointDiffSize,
  type WebhookService,
} from "./webhook.ts";
import {
  keepLastGoodRouteFiles,
  type KeptRouteFile,
  mergeWebhookRoutes,
  parseRouteFiles,
  type RefusedRouteFile,
  type RouteFileLoad,
  type ShadowedRouteFile,
  shadowedRouteFileMessage,
  WebhookRoutesDirPlacementError,
} from "./webhook_route_files.ts";

export interface WebhookReloadResult {
  readonly changed: number;
  readonly warnings: readonly string[];
  /**
   * refused route files, kept stale routes or the routes directory; the other
   * routes still applied
   */
  readonly errors: readonly string[];
}

export type WebhookApplyTrigger = "startup" | "reload" | "signal" | "poll";

export interface WebhookApplyContext {
  readonly trigger: WebhookApplyTrigger;
  /** who asked, for a reload over the serve socket; absent means system */
  readonly principal?: { readonly kind: string; readonly id: string };
  readonly client?: string;
  readonly sourceIp?: string;
}

export type WebhookUpdater = (
  configs: readonly WebhookConfigEntry[],
  context?: WebhookApplyContext,
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
  /** why a kept file route may no longer serve, judged on the live trust list */
  readonly keepRefusal?: (endpoint: WebhookEndpoint) => string | undefined;
}

export interface WebhookRouteTable {
  readonly endpoints: readonly WebhookEndpoint[];
  readonly refused: readonly RefusedRouteFile[];
  readonly kept: readonly KeptRouteFile[];
  readonly shadowed: readonly ShadowedRouteFile[];
  /** the routes directory could not be used, so no new file route loaded */
  readonly directoryError?: string;
}

/** operator routes parse all-or-nothing; route files are refused one at a time */
export async function buildWebhookRouteTable(
  deps: WebhookRouteTableDeps,
  configs: readonly WebhookConfigEntry[],
  previous: readonly WebhookEndpoint[] = [],
): Promise<WebhookRouteTable> {
  const operator: WebhookEndpoint[] = deps.source === "flag"
    ? (deps.flagEndpoints ?? []).map((e) => ({ ...e, source: "flag" }))
    : (configs.length > 0 ? await deps.parse(configs) : []).map((e) => ({
      ...e,
      source: "config",
    }));
  let load: RouteFileLoad = { files: [], refused: [] };
  let directoryError: string | undefined;
  let directoryUnreadable = false;
  if (deps.loadRouteFiles) {
    try {
      load = await deps.loadRouteFiles();
    } catch (error) {
      // a bad routes directory never stops serve or the operator routes
      directoryError = error instanceof Error ? error.message : String(error);
      directoryUnreadable = !(error instanceof WebhookRoutesDirPlacementError);
    }
  }
  const parsed = await parseRouteFiles(load.files, deps.parse, previous);
  const fileRoutes = keepLastGoodRouteFiles({
    previous,
    files: load.files,
    parsed,
    loaderRefused: load.refused,
    directoryUnreadable,
    ...(deps.keepRefusal ? { keepRefusal: deps.keepRefusal } : {}),
  });
  const { endpoints, shadowed } = mergeWebhookRoutes(
    operator,
    fileRoutes.endpoints,
  );
  return {
    endpoints,
    refused: fileRoutes.refused,
    kept: fileRoutes.kept,
    shadowed,
    ...(directoryError !== undefined ? { directoryError } : {}),
  };
}

/** what health reports about route files; written only by the applier */
export interface WebhookRouteFileStatus {
  readonly lastApplied: {
    readonly at: string;
    readonly trigger: WebhookApplyTrigger;
  } | null;
  readonly refused: readonly RefusedRouteFile[];
  readonly kept: readonly KeptRouteFile[];
  readonly shadowed: readonly ShadowedRouteFile[];
  readonly directoryError?: string;
}

/** one applied change to the live routes or to their refusals */
export interface WebhookRouteApplyRecord {
  readonly context: WebhookApplyContext;
  readonly diff: WebhookEndpointDiff;
  readonly refused: readonly RefusedRouteFile[];
  readonly kept: readonly KeptRouteFile[];
  readonly directoryError?: string;
  readonly outcome: "success" | "failure";
}

export interface WebhookUpdaterDeps extends WebhookRouteTableDeps {
  readonly service: Pick<
    WebhookService,
    "updateEndpoints" | "currentEndpoints"
  >;
  /** the serve config list serve started with, reused by a route-file poll */
  readonly initialConfigs?: readonly WebhookConfigEntry[];
  /** the table serve started with, so health reports it before any reload */
  readonly initialTable?: WebhookRouteTable;
  /** runs after an apply that changed routes or refusals; must not throw */
  readonly onApplied?: (record: WebhookRouteApplyRecord) => void;
  readonly now?: () => Date;
}

export interface WebhookRouteApplier {
  readonly update: WebhookUpdater;
  /** re-reads route files only, against the serve config list last applied */
  reapplyRouteFiles(context: WebhookApplyContext): Promise<WebhookReloadResult>;
  status(): WebhookRouteFileStatus;
}

function refusalSignature(
  status: Pick<WebhookRouteFileStatus, "refused" | "kept" | "directoryError">,
): string {
  return JSON.stringify([
    status.refused.map((r) => r.message).sort(),
    status.kept.map((k) => k.message).sort(),
    status.directoryError ?? null,
  ]);
}

export function createWebhookRouteApplier(
  deps: WebhookUpdaterDeps,
): WebhookRouteApplier {
  const now = deps.now ?? (() => new Date());
  let lastConfigs: readonly WebhookConfigEntry[] = deps.initialConfigs ?? [];
  let status: WebhookRouteFileStatus = deps.initialTable
    ? {
      lastApplied: { at: now().toISOString(), trigger: "startup" },
      refused: deps.initialTable.refused,
      kept: deps.initialTable.kept,
      shadowed: deps.initialTable.shadowed,
      ...(deps.initialTable.directoryError !== undefined
        ? { directoryError: deps.initialTable.directoryError }
        : {}),
    }
    : { lastApplied: null, refused: [], kept: [], shadowed: [] };
  // a reload and a poll both read the live table as the previous one
  let tail: Promise<void> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.then(() => {}, () => {});
    return result;
  };

  const apply = async (
    configs: readonly WebhookConfigEntry[],
    context: WebhookApplyContext,
  ): Promise<WebhookReloadResult> => {
    const previous = deps.service.currentEndpoints();
    const table = await buildWebhookRouteTable(deps, configs, previous);
    const diff = diffWebhookEndpoints(previous, table.endpoints);
    const changed = deps.service.updateEndpoints(table.endpoints);
    lastConfigs = configs;
    const errors = [
      ...(table.directoryError !== undefined ? [table.directoryError] : []),
      ...table.refused.map((refused) => refused.message),
      ...table.kept.map((kept) => kept.message),
    ];
    const next: WebhookRouteFileStatus = {
      lastApplied: { at: now().toISOString(), trigger: context.trigger },
      refused: table.refused,
      kept: table.kept,
      shadowed: table.shadowed,
      ...(table.directoryError !== undefined
        ? { directoryError: table.directoryError }
        : {}),
    };
    const refusalsChanged = refusalSignature(next) !==
      refusalSignature(status);
    status = next;
    if (
      deps.onApplied &&
      (webhookEndpointDiffSize(diff) > 0 || refusalsChanged)
    ) {
      deps.onApplied({
        context,
        diff,
        refused: table.refused,
        kept: table.kept,
        ...(table.directoryError !== undefined
          ? { directoryError: table.directoryError }
          : {}),
        outcome: errors.length > 0 ? "failure" : "success",
      });
    }
    const warnings = [
      ...(deps.source === "flag" && configs.length > 0
        ? [FLAG_ROUTES_WARNING]
        : []),
      ...table.shadowed.map(shadowedRouteFileMessage),
    ];
    return { changed, warnings, errors };
  };

  return {
    update: (configs, context) =>
      serialized(() => apply(configs, context ?? { trigger: "reload" })),
    reapplyRouteFiles: (context) =>
      serialized(() => apply(lastConfigs, context)),
    status: () => status,
  };
}

export function createWebhookUpdater(deps: WebhookUpdaterDeps): WebhookUpdater {
  return createWebhookRouteApplier(deps).update;
}
