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
   * Model types that need admin authority to create or run, each held as its
   * normalizeModelTypeName key (no leading `@`), so `@exp/probe` and
   * `exp/probe` name the same entry (swamp-club#3129).
   */
  restrictedModelTypes: string[];
  restrictedCommands: string[];
  /**
   * When true, deciding a manual approval gate needs a grant that names
   * `approve`; a `run` grant alone no longer implies it. Off by default.
   */
  approveRequiresExplicitGrant: boolean;
  /**
   * When true, delivering a signal to a workflow's wait needs a grant that
   * names `signal`; a `run` grant alone no longer implies it. Off by default.
   */
  signalRequiresExplicitGrant: boolean;
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
}

/**
 * Splits a comma-separated option value into trimmed, non-empty entries. The
 * serve config file's lists reach here joined with commas, so serve and
 * `serve check-config` split entries the same way.
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
        `Invalid restricted-model-types entry "${entry}": it names no model type`,
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
    let providerUrl: URL;
    try {
      providerUrl = new URL(oauthProvider);
    } catch {
      throw new UserError(
        `Invalid --oauth-provider URL "${oauthProvider}": expected a valid URL`,
      );
    }
    const isLocalhost = providerUrl.hostname === "localhost" ||
      providerUrl.hostname === "127.0.0.1" ||
      providerUrl.hostname === "::1";
    if (providerUrl.protocol !== "https:" && !isLocalhost) {
      throw new UserError(
        `--oauth-provider must use HTTPS (got ${oauthProvider}). ` +
          "HTTP is only allowed for localhost development.",
      );
    }
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
  };
}

/** A restriction entry that cannot restrict anything as written. */
export interface IneffectiveRestriction {
  readonly option: "restricted-model-types" | "restricted-commands";
  readonly entry: string;
  /**
   * `no-type`: the entry names no model type at all (`@`, `::`); serve
   * refuses to start. `unknown-type`: a bare entry naming no registered
   * type, likely misspelled or missing its `@`. `unknown-command`: not a
   * server request type; commands match exactly.
   */
  readonly reason: "no-type" | "unknown-type" | "unknown-command";
  readonly message: string;
}

export interface IneffectiveRestrictionInput {
  /** The comma-separated values as merged from flags and serve.yaml. */
  readonly restrictedModelTypes?: string;
  readonly restrictedCommands?: string;
  /** The server request type names `restricted-commands` is matched against. */
  readonly requestTypes: ReadonlySet<string>;
  /**
   * Whether a model type is registered. Omitted where the registry is not
   * loaded (`serve check-config`), which skips the `unknown-type` check.
   */
  readonly isKnownModelType?: (type: string) => boolean;
}

/**
 * Finds restriction entries that can never match, so serve and
 * `serve check-config` can say so instead of silently restricting nothing.
 * An entry with a leading `@` is not checked against the registry: an
 * extension type can be installed or auto-resolved after startup.
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
          `Invalid restricted-model-types entry "${entry}": it names no model type`,
      });
      continue;
    }
    const isKnown = input.isKnownModelType;
    if (
      isKnown !== undefined && !entry.startsWith("@") &&
      !isKnown(key) && !isKnown(`@${key}`)
    ) {
      found.push({
        option: "restricted-model-types",
        entry,
        reason: "unknown-type",
        message:
          `restricted-model-types entry "${entry}" names no registered model type — check the spelling, or write an extension type as @${key}`,
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
