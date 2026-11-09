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

// route files are limited to this prefix; serve.yaml and --webhook routes are not
export const WEBHOOK_ROUTE_PREFIX = "/hooks/";

// unreserved URL characters only, so the route is its own canonical pathname
const FILE_ROUTE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** why a route file's route is refused, or undefined when it is allowed */
export function fileRouteProblem(route: string): string | undefined {
  if (!route.startsWith(WEBHOOK_ROUTE_PREFIX)) {
    return `is not under ${WEBHOOK_ROUTE_PREFIX}, which route files require`;
  }
  const rest = route.slice(WEBHOOK_ROUTE_PREFIX.length);
  if (rest.length === 0) {
    return `is the bare ${WEBHOOK_ROUTE_PREFIX} prefix; name a route under it`;
  }
  for (const segment of rest.split("/")) {
    if (segment.length === 0) return "has an empty segment";
    if (segment === "." || segment === "..") {
      return "has a '.' or '..' segment, which no request path can match";
    }
    if (!FILE_ROUTE_SEGMENT.test(segment)) {
      return `has segment '${segment}' with characters other than letters, ` +
        "digits and '-', '.', '_', '~'";
    }
  }
  return undefined;
}
