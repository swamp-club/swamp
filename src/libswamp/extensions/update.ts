// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import {
  buildUpdateResult,
  checkExtensionVersion,
  type ExtensionUpdateResult,
  type ExtensionUpdateStatus,
} from "../../domain/extensions/extension_update_service.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import type { InstallResult } from "./pull.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export type ExtensionUpdateEvent =
  | { kind: "no_extensions" }
  | { kind: "extension_not_installed"; name: string }
  | { kind: "checking"; name: string }
  | { kind: "updating"; name: string; from: string; to: string }
  | {
    kind: "orphans-pruned";
    name: string;
    from: string;
    to: string;
    paths: string[];
  }
  | { kind: "completed"; data: ExtensionUpdateResult; mode: "check" | "update" }
  | { kind: "error"; error: SwampError };

/** Input for the extension update operation. */
export interface ExtensionUpdateInput {
  /** Specific extension to update, or undefined for all. */
  extensionName?: string;
  /** When true, only check for updates without pulling. */
  checkOnly: boolean;
}

/** Dependencies for the extension update operation. */
export interface ExtensionUpdateDeps {
  /** Read installed upstream extensions. Returns map of name -> { version }. */
  readUpstreamExtensions: () => Promise<
    Record<string, { version: string }>
  >;
  /** Get extension info from registry (latest version). */
  getExtension: (
    name: string,
  ) => Promise<{ latestVersion: string | null } | null>;
  /**
   * Install/update a specific extension to a version. Returns the
   * `InstallResult` so the update path can surface the pruned orphan
   * list to the user, or `undefined` when the install short-circuited
   * (alreadyPulled in the same call chain). Errors propagate as throws.
   */
  installExtension: (
    name: string,
    version: string,
  ) => Promise<InstallResult | undefined>;
}

/** Wires real infrastructure into ExtensionUpdateDeps. */
export function createExtensionUpdateDeps(options: {
  lockfilePath: string;
  serverUrl?: string;
  installExtension: (
    name: string,
    version: string,
  ) => Promise<InstallResult | undefined>;
}): ExtensionUpdateDeps {
  const extensionClient = new ExtensionApiClient(
    options.serverUrl ?? resolveServerUrl(),
  );
  return {
    readUpstreamExtensions: () => readUpstreamExtensions(options.lockfilePath),
    getExtension: async (name) => {
      try {
        const info = await extensionClient.getExtension(name);
        if (!info) return null;
        return { latestVersion: info.latestVersion ?? null };
      } catch {
        return null;
      }
    },
    installExtension: options.installExtension,
  };
}

/** Checks for and optionally applies extension updates. */
export async function* extensionUpdate(
  ctx: LibSwampContext,
  deps: ExtensionUpdateDeps,
  input: ExtensionUpdateInput,
): AsyncIterable<ExtensionUpdateEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.update",
    {},
    (async function* () {
      ctx.logger.debug`Executing extension update`;

      const upstream = await deps.readUpstreamExtensions();
      const installedNames = Object.keys(upstream);

      if (installedNames.length === 0) {
        yield { kind: "no_extensions" };
        return;
      }

      // Validate specific extension exists
      let targetNames: string[];
      if (input.extensionName) {
        if (!upstream[input.extensionName]) {
          yield { kind: "extension_not_installed", name: input.extensionName };
          yield {
            kind: "error",
            error: validationFailed(
              `Extension ${input.extensionName} is not installed. Use 'swamp extension pull ${input.extensionName}' to install it.`,
            ),
          };
          return;
        }
        targetNames = [input.extensionName];
      } else {
        targetNames = installedNames;
      }

      // Check each extension for updates
      const statuses: ExtensionUpdateStatus[] = [];
      for (const name of targetNames) {
        yield { kind: "checking", name };
        const installedVersion = upstream[name].version;

        const extInfo = await deps.getExtension(name);
        if (!extInfo) {
          statuses.push({
            status: "not_found",
            name,
            installedVersion,
            error: `Failed to fetch registry info for ${name}.`,
          });
          continue;
        }

        statuses.push(
          checkExtensionVersion(name, installedVersion, extInfo.latestVersion),
        );
      }

      // Check-only mode
      if (input.checkOnly) {
        yield {
          kind: "completed",
          data: buildUpdateResult(statuses),
          mode: "check",
        };
        return;
      }

      // Update mode
      const finalStatuses: ExtensionUpdateStatus[] = [];
      for (const s of statuses) {
        if (s.status === "update_available") {
          yield {
            kind: "updating",
            name: s.name,
            from: s.installedVersion,
            to: s.latestVersion,
          };

          try {
            const result = await deps.installExtension(
              s.name,
              s.latestVersion,
            );
            if (result && result.pruned.length > 0) {
              yield {
                kind: "orphans-pruned",
                name: s.name,
                from: s.installedVersion,
                to: s.latestVersion,
                paths: result.pruned,
              };
            }
            finalStatuses.push({
              status: "updated",
              name: s.name,
              previousVersion: s.installedVersion,
              newVersion: s.latestVersion,
            });
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : String(error);
            finalStatuses.push({
              status: "failed",
              name: s.name,
              installedVersion: s.installedVersion,
              error: `Update failed: ${message}`,
            });
          }
        } else {
          finalStatuses.push(s);
        }
      }

      yield {
        kind: "completed",
        data: buildUpdateResult(finalStatuses),
        mode: "update",
      };
    })(),
  );
}
