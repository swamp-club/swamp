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
}

function parseCommaSeparated(value: string | undefined): string[] {
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
    try {
      parseSubject(admin);
    } catch {
      throw new UserError(
        `Invalid --admins value "${admin}": expected format "user:<id>", "group:<name>", or "idp-group:<name>"`,
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
    const providerUrl = new URL(oauthProvider);
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
  };
}
