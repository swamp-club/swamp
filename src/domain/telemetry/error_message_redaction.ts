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

// See also: sanitizeErrorForClient in src/serve/handlers/shared.ts, which
// solves the same class of problem for WebSocket error frames with a
// destructive strategy (replaces the entire message). Telemetry preserves
// diagnostic structure by normalizing in-place instead.

const HOME_PATH_RE = /(\/Users\/|\/home\/|C:\\Users\\|C:\/Users\/)([^\s/\\]+)/g;

const INTERNAL_HOST_RE =
  /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:internal|local|lan|corp|intranet|private|home)\b/g;

export function redactErrorMessage(message: string): string {
  let result = message.replace(
    HOME_PATH_RE,
    (_match, prefix: string, _username: string) => `${prefix}<REDACTED>`,
  );

  result = result.replace(INTERNAL_HOST_RE, "<REDACTED-HOST>");

  return result;
}
