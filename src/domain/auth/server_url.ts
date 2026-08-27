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

/**
 * Normalize a server URL for use as a credential map key.
 *
 * Lowercases the hostname, strips trailing slashes from the path,
 * and removes default ports (80 for http, 443 for https).
 *
 * @throws {TypeError} if the input is not a valid URL
 */
export function normalizeServerUrl(url: string): string {
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `Unsupported protocol: ${parsed.protocol} (expected http: or https:)`,
    );
  }

  // new URL already lowercases the hostname.
  // Strip default ports — URL parser stores them in .port as "" when they
  // match the scheme default, but explicit ":443" / ":80" may be present
  // in the original string and preserved by some environments.
  let host = parsed.hostname;
  if (parsed.port) {
    const isDefaultPort =
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80");
    if (!isDefaultPort) {
      host = `${host}:${parsed.port}`;
    }
  }

  // Strip trailing slashes from the pathname, but preserve non-root paths.
  const pathname = parsed.pathname.replace(/\/+$/, "") || "";

  return `${parsed.protocol}//${host}${pathname}`;
}
