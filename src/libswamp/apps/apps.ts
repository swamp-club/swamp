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

import { basename } from "@std/path";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type AppApprovalRepository,
  type AppState,
  appState,
} from "../../domain/apps/app_approval.ts";
import type {
  AppCatalog,
  AppCatalogProblem,
  AppOrigin,
  InstalledApp,
} from "../../domain/apps/app_catalog.ts";
import { capabilityKey } from "../../domain/apps/app_descriptor.ts";
import {
  APP_FILES_PATH,
  APP_LAUNCH_TTL_MS,
  appApprovalStamp,
  type AppLaunchKey,
  mintAppLaunchToken,
} from "../../domain/apps/app_launch.ts";
import type { LibSwampContext } from "../context.ts";
import {
  formatRequirement,
  type HeldPlatform,
  platformRefusal,
  platformRequirement,
} from "../../domain/apps/app_platform.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

export interface AppDeps {
  catalog: AppCatalog;
  approvals: AppApprovalRepository;
  /** Only `appLaunch` signs with it, so the CLI's app commands hold none. */
  launchKey?: AppLaunchKey;
  now: () => Date;
  /** The app platforms this swamp serves; absent, an app's is not checked. */
  platforms?: () => Promise<readonly HeldPlatform[]>;
}

/** A behavior an app may call, and the only methods of it the app may run. */
export interface AppMethod {
  readonly behavior: string;
  readonly type: string;
  readonly methods: readonly string[];
}

export interface AppSummary {
  readonly name: string;
  readonly title: string;
  readonly state: AppState;
  readonly origin: AppOrigin;
  readonly built: boolean;
  readonly dev: boolean;
  readonly version?: string;
  readonly capabilities: readonly string[];
  readonly run: readonly string[];
  readonly methods: readonly AppMethod[];
  /** What `approve` must be sent, so an operator approves what they saw. */
  readonly capabilityKey: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  /** The platform it was built for, as `app.yaml` names it. */
  readonly platform: string;
  /** Why this swamp cannot run it, when its platform is not one it serves. */
  readonly platformProblem?: string;
}

export interface AppListData {
  readonly apps: readonly AppSummary[];
  readonly problems: readonly AppCatalogProblem[];
}

export type AppListEvent =
  | { kind: "completed"; data: AppListData }
  | { kind: "error"; error: SwampError };

async function summarize(
  deps: Pick<AppDeps, "approvals">,
  app: InstalledApp,
  held?: readonly HeldPlatform[],
): Promise<AppSummary> {
  const key = capabilityKey(app.descriptor, app.origin);
  const approval = await deps.approvals.get(app.descriptor.name);
  const requirement = platformRequirement(app.descriptor.platform);
  const platformProblem = held === undefined
    ? null
    : platformRefusal(requirement, held);
  return {
    name: app.descriptor.name,
    title: app.descriptor.title,
    // a dev server is the author's own session and is never recorded
    state: app.devUrl !== undefined ? "enabled" : appState(key, approval),
    origin: app.origin,
    built: app.built,
    dev: app.devUrl !== undefined,
    ...(app.version !== undefined ? { version: app.version } : {}),
    capabilities: app.descriptor.capabilities,
    run: app.descriptor.run,
    methods: app.descriptor.methods,
    capabilityKey: key,
    ...(approval !== null
      ? { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt }
      : {}),
    platform: formatRequirement(requirement),
    ...(platformProblem !== null ? { platformProblem } : {}),
  };
}

export async function* appList(
  _ctx: LibSwampContext,
  deps: Pick<AppDeps, "catalog" | "approvals" | "platforms">,
): AsyncIterable<AppListEvent> {
  yield* withGeneratorSpan(
    "swamp.app.list",
    {},
    (async function* (): AsyncGenerator<AppListEvent> {
      const listing = await deps.catalog.list();
      const apps: AppSummary[] = [];
      const held = await deps.platforms?.();
      for (const app of listing.apps) {
        apps.push(await summarize(deps, app, held));
      }
      yield {
        kind: "completed",
        data: { apps, problems: listing.problems },
      };
    })(),
  );
}

async function findApp(
  catalog: AppCatalog,
  name: string,
): Promise<InstalledApp | undefined> {
  const { apps } = await catalog.list();
  return apps.find((app) => app.descriptor.name === name);
}

export interface AppApproveInput {
  readonly name: string;
  readonly approvedBy: string;
  /** When set, the approval is refused if the app now asks for anything else. */
  readonly capabilityKey?: string;
}

export interface AppApproveData {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly run: readonly string[];
  readonly methods: readonly AppMethod[];
  readonly capabilityKey: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export type AppApproveEvent =
  | { kind: "completed"; data: AppApproveData }
  | { kind: "error"; error: SwampError };

export async function* appApprove(
  _ctx: LibSwampContext,
  deps: Pick<AppDeps, "catalog" | "approvals" | "now">,
  input: AppApproveInput,
): AsyncIterable<AppApproveEvent> {
  yield* withGeneratorSpan(
    "swamp.app.approve",
    { "app.name": input.name },
    (async function* (): AsyncGenerator<AppApproveEvent> {
      const app = await findApp(deps.catalog, input.name);
      if (app === undefined) {
        yield { kind: "error", error: notFound("App", input.name) };
        return;
      }
      const key = capabilityKey(app.descriptor, app.origin);
      if (input.capabilityKey !== undefined && input.capabilityKey !== key) {
        yield {
          kind: "error",
          error: validationFailed(
            `${input.name} changed what it asks for. Review it again before you enable it.`,
          ),
        };
        return;
      }
      const approvedAt = deps.now().toISOString();
      await deps.approvals.save({
        name: input.name,
        capabilityKey: key,
        approvedBy: input.approvedBy,
        approvedAt,
      });
      yield {
        kind: "completed",
        data: {
          name: input.name,
          capabilities: app.descriptor.capabilities,
          run: app.descriptor.run,
          methods: app.descriptor.methods,
          capabilityKey: key,
          approvedBy: input.approvedBy,
          approvedAt,
        },
      };
    })(),
  );
}

export interface AppRevokeData {
  readonly name: string;
  readonly revoked: boolean;
}

export type AppRevokeEvent =
  | { kind: "completed"; data: AppRevokeData }
  | { kind: "error"; error: SwampError };

export async function* appRevoke(
  _ctx: LibSwampContext,
  deps: Pick<AppDeps, "catalog" | "approvals">,
  input: { readonly name: string },
): AsyncIterable<AppRevokeEvent> {
  yield* withGeneratorSpan(
    "swamp.app.revoke",
    { "app.name": input.name },
    (async function* (): AsyncGenerator<AppRevokeEvent> {
      // an approval left by an app since removed can still be cleared
      const installed = await findApp(deps.catalog, input.name);
      if (
        installed === undefined &&
        await deps.approvals.get(input.name) === null
      ) {
        yield { kind: "error", error: notFound("App", input.name) };
        return;
      }
      // a launch is checked against the approval on every file, so this ends it
      const revoked = await deps.approvals.delete(input.name);
      yield { kind: "completed", data: { name: input.name, revoked } };
    })(),
  );
}

export interface AppLaunchData {
  readonly name: string;
  readonly title: string;
  /** Relative to the server, or a loopback URL for a dev server. */
  readonly url: string;
  readonly capabilities: readonly string[];
  readonly run: readonly string[];
  readonly methods: readonly AppMethod[];
}

export type AppLaunchEvent =
  | { kind: "completed"; data: AppLaunchData }
  | { kind: "error"; error: SwampError };

export async function* appLaunch(
  _ctx: LibSwampContext,
  deps:
    & Pick<AppDeps, "catalog" | "approvals" | "now" | "platforms">
    & Required<Pick<AppDeps, "launchKey">>,
  input: { readonly name: string },
): AsyncIterable<AppLaunchEvent> {
  yield* withGeneratorSpan(
    "swamp.app.launch",
    { "app.name": input.name },
    (async function* (): AsyncGenerator<AppLaunchEvent> {
      const app = await findApp(deps.catalog, input.name);
      if (app === undefined) {
        yield { kind: "error", error: notFound("App", input.name) };
        return;
      }
      const shared = {
        name: input.name,
        title: app.descriptor.title,
        capabilities: app.descriptor.capabilities,
        run: app.descriptor.run,
        methods: app.descriptor.methods,
      };
      if (app.devUrl !== undefined) {
        yield { kind: "completed", data: { ...shared, url: app.devUrl } };
        return;
      }
      const summary = await summarize(deps, app);
      if (summary.state !== "enabled" || summary.approvedAt === undefined) {
        yield {
          kind: "error",
          error: validationFailed(
            `${input.name} is not enabled. An operator has to approve it first.`,
          ),
        };
        return;
      }
      if (!app.built) {
        yield {
          kind: "error",
          error: validationFailed(
            `${input.name} has no build at ${app.descriptor.entry}. Run swamp app build.`,
          ),
        };
        return;
      }
      if (deps.platforms !== undefined) {
        const refusal = platformRefusal(
          platformRequirement(app.descriptor.platform),
          await deps.platforms(),
        );
        if (refusal !== null) {
          yield {
            kind: "error",
            error: validationFailed(
              `${input.name} cannot open here. ${refusal}`,
            ),
          };
          return;
        }
      }
      const token = await mintAppLaunchToken(await deps.launchKey.signing(), {
        name: input.name,
        expiresAt: deps.now().getTime() + APP_LAUNCH_TTL_MS,
        approvalStamp: await appApprovalStamp({
          capabilityKey: summary.capabilityKey,
          approvedAt: summary.approvedAt,
        }),
      });
      yield {
        kind: "completed",
        data: {
          ...shared,
          url: `${APP_FILES_PATH}/${token}/${basename(app.descriptor.entry)}`,
        },
      };
    })(),
  );
}
