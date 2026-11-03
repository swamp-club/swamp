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

import { UserError } from "../errors.ts";
import { normalizeModelTypeName } from "../models/control_plane_types.ts";
import { parseSubject } from "./subject.ts";

export type AuthMode = "none" | "token" | "oauth";

export interface ServeAuthConfig {
  mode: AuthMode;
  admins: string[];
  allowedCollectives: string[];
  allowedUsers: string[];
  oauthProvider: string;
  oauthClientId?: string;
  groupsField: string;
  /**
   * held as normalizeModelTypeName keys with no leading @, so @exp/probe and
   * exp/probe name the same entry
   */
  restrictedModelTypes: string[];
  restrictedCommands: string[];
  approveRequiresExplicitGrant: boolean;
  signalRequiresExplicitGrant: boolean;
  tagRequiresExplicitGrant: boolean;
}

const VALID_AUTH_MODES: ReadonlySet<string> = new Set([
  "none",
  "token",
  "oauth",
]);
const DEFAULT_OAUTH_PROVIDER = "https://swamp-club.com";
const DEFAULT_GROUPS_FIELD = "collectives";

export interface ServeAuthConfigInput {
  authMode?: string;
  admins?: string;
  allowedCollectives?: string;
  allowedUsers?: string;
  oauthProvider?: string;
  oauthClientId?: string;
  groupsField?: string;
  restrictedModelTypes?: string;
  restrictedCommands?: string;
  approveRequiresExplicitGrant?: boolean;
  signalRequiresExplicitGrant?: boolean;
  tagRequiresExplicitGrant?: boolean;
}

/**
 * the serve config file's lists reach here joined with commas, so serve and
 * serve check-config split entries the same way
 */
export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function validateAdmins(admins: string[], mode: string): void {
  if (mode === "oauth") {
    for (const admin of admins) {
      if (admin.trim().length === 0) {
        throw new UserError("--admins contains an empty value");
      }
    }
    return;
  }
  for (const admin of admins) {
    let subject;
    try {
      subject = parseSubject(admin);
    } catch {
      throw new UserError(
        `Invalid --admins value "${admin}": expected format "user:<id>", "group:<name>", or "idp-group:<name>"`,
      );
    }
    if (subject.kind === "service") {
      throw new UserError(
        `Invalid --admins value "${admin}": a built-in service principal cannot be an admin`,
      );
    }
    if (subject.kind === "collective") {
      throw new UserError(
        `Invalid --admins value "${admin}": a collective cannot be an admin; list its admins as users or a group instead`,
      );
    }
  }
}

export function buildServeAuthConfig(
  input: ServeAuthConfigInput,
): ServeAuthConfig {
  const mode = input.authMode ?? "none";
  if (!VALID_AUTH_MODES.has(mode)) {
    throw new UserError(
      `Invalid --auth-mode value "${mode}": must be "none", "token", or "oauth"`,
    );
  }

  const admins = parseCommaSeparated(input.admins);
  const allowedCollectives = parseCommaSeparated(input.allowedCollectives);
  const allowedUsers = parseCommaSeparated(input.allowedUsers);
  const oauthProvider = input.oauthProvider ?? DEFAULT_OAUTH_PROVIDER;
  const oauthClientId = input.oauthClientId;
  const groupsField = input.groupsField ?? DEFAULT_GROUPS_FIELD;
  const restrictedModelTypes = parseCommaSeparated(
    input.restrictedModelTypes,
  ).map((entry) => {
    const key = normalizeModelTypeName(entry);
    if (key === null) {
      throw new UserError(
        `Invalid restricted-model-types entry "${entry}": it names no behavior type`,
      );
    }
    return key;
  });
  const restrictedCommands = parseCommaSeparated(input.restrictedCommands);

  if (admins.length > 0) {
    validateAdmins(admins, mode);
  }

  if (mode === "token") {
    if (admins.length === 0) {
      throw new UserError(
        '--admins is required when --auth-mode is "token"',
      );
    }
  }

  if (mode === "oauth") {
    if (admins.length === 0) {
      throw new UserError(
        '--admins is required when --auth-mode is "oauth"',
      );
    }
    if (allowedCollectives.length === 0 && allowedUsers.length === 0) {
      throw new UserError(
        '--allowed-collectives or --allowed-users is required when --auth-mode is "oauth" — ' +
          "without admission restrictions, any swamp-club user can connect",
      );
    }
    resolveOAuthProviderUrl(oauthProvider);
  }

  return {
    mode: mode as AuthMode,
    admins,
    allowedCollectives,
    allowedUsers,
    oauthProvider,
    oauthClientId,
    groupsField,
    restrictedModelTypes,
    restrictedCommands,
    approveRequiresExplicitGrant: input.approveRequiresExplicitGrant ?? false,
    signalRequiresExplicitGrant: input.signalRequiresExplicitGrant ?? false,
    tagRequiresExplicitGrant: input.tagRequiresExplicitGrant ?? false,
  };
}

/** the default and the HTTPS rule serve applies to --oauth-provider */
export function resolveOAuthProviderUrl(
  oauthProvider: string | undefined,
): string {
  const provider = oauthProvider ?? DEFAULT_OAUTH_PROVIDER;
  let providerUrl: URL;
  try {
    providerUrl = new URL(provider);
  } catch {
    throw new UserError(
      `Invalid --oauth-provider URL "${provider}": expected a valid URL`,
    );
  }
  const isLocalhost = providerUrl.hostname === "localhost" ||
    providerUrl.hostname === "127.0.0.1" ||
    providerUrl.hostname === "::1";
  if (providerUrl.protocol !== "https:" && !isLocalhost) {
    throw new UserError(
      `--oauth-provider must use HTTPS (got ${provider}). ` +
        "HTTP is only allowed for localhost development.",
    );
  }
  return provider;
}

export interface IneffectiveRestriction {
  readonly option: "restricted-model-types" | "restricted-commands";
  readonly entry: string;
  /**
   * no-type: names no model type at all and serve refuses to start;
   * unknown-type: a bare entry matching no known type, likely misspelled or
   * missing its @; unknown-command: commands match exactly
   */
  readonly reason: "no-type" | "unknown-type" | "unknown-command";
  readonly message: string;
}

export interface IneffectiveRestrictionInput {
  readonly restrictedModelTypes?: string;
  readonly restrictedCommands?: string;
  readonly requestTypes: ReadonlySet<string>;
  readonly isKnownModelType?: (type: string) => boolean;
  /**
   * used when isKnownModelType is omitted: built-in types need no registry
   * load, so check-config can check bare entries; a bare extension type is
   * reported too, as it cannot be seen without loading extensions
   */
  readonly isBuiltInModelType?: (type: string) => boolean;
}

/**
 * an entry with a leading @ is not checked against the registry, since an
 * extension type can be installed or auto-resolved after startup
 */
export function findIneffectiveRestrictions(
  input: IneffectiveRestrictionInput,
): IneffectiveRestriction[] {
  const found: IneffectiveRestriction[] = [];
  for (const entry of parseCommaSeparated(input.restrictedModelTypes)) {
    const key = normalizeModelTypeName(entry);
    if (key === null) {
      found.push({
        option: "restricted-model-types",
        entry,
        reason: "no-type",
        message:
          `Invalid restricted-model-types entry "${entry}": it names no behavior type`,
      });
      continue;
    }
    if (entry.startsWith("@")) continue;
    const isKnown = input.isKnownModelType;
    const isBuiltIn = input.isBuiltInModelType;
    if (isKnown !== undefined) {
      if (!isKnown(key) && !isKnown(`@${key}`)) {
        found.push({
          option: "restricted-model-types",
          entry,
          reason: "unknown-type",
          message:
            `restricted-model-types entry "${entry}" names no registered behavior type — check the spelling, or write an extension type as @${key}`,
        });
      }
    } else if (isBuiltIn !== undefined && !isBuiltIn(key)) {
      found.push({
        option: "restricted-model-types",
        entry,
        reason: "unknown-type",
        message:
          `restricted-model-types entry "${entry}" is not a built-in behavior type — check the spelling; if it names an extension type, write it as @${key}`,
      });
    }
  }
  for (const entry of parseCommaSeparated(input.restrictedCommands)) {
    if (!input.requestTypes.has(entry)) {
      found.push({
        option: "restricted-commands",
        entry,
        reason: "unknown-command",
        message:
          `restricted-commands entry "${entry}" is not a server command and restricts nothing — command names match exactly`,
      });
    }
  }
  return found;
}
