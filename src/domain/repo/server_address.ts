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
import { normalizeServerUrl, redactServerUrl } from "../auth/server_url.ts";

/**
 * Check that a serve URL can be stored as `serverAddress` in `.swamp.yaml`.
 *
 * `.swamp.yaml` is usually committed, so the stored URL must carry no
 * credential. A userinfo part, a query string (serve accepts `?token=`)
 * or a fragment is refused. Connections never use those parts anyway: the
 * token comes from `--token`, `SWAMP_SERVER_TOKEN` or stored credentials.
 *
 * Error messages show the URL only in its {@link redactServerUrl} form.
 *
 * @throws {UserError} if the value is not an http, https, ws or wss URL with
 *   a host, or if it has a userinfo part, a query string or a fragment
 */
export function assertStorableServerAddress(value: string): void {
  const shown = redactServerUrl(value);
  if (shown === undefined || !hasSupportedScheme(value)) {
    throw new UserError(
      `Invalid --server URL${
        shown === undefined ? "" : ` '${shown}'`
      } — expected http://, https://, ws:// or wss:// followed by a host`,
    );
  }

  const url = new URL(value);
  const parts: string[] = [];
  if (url.username || url.password) parts.push("a username or password");
  if (url.search) parts.push("a query string");
  if (url.hash) parts.push("a fragment");
  if (parts.length === 0) return;

  throw new UserError(
    `Refusing to store the --server URL '${shown}' in .swamp.yaml: it has ` +
      `${joinWithAnd(parts)}, which can carry a credential, and .swamp.yaml ` +
      `is usually committed. Use '${shown}' here, and give remote commands ` +
      `the serve token with --token or SWAMP_SERVER_TOKEN, or store it with: ` +
      `swamp auth server-login --server ${shown}`,
  );
}

function hasSupportedScheme(value: string): boolean {
  try {
    normalizeServerUrl(value);
    return true;
  } catch {
    return false;
  }
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
