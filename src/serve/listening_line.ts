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

import type { AuthMode } from "../domain/access/serve_auth_config.ts";
import type { DeploymentMode } from "../domain/serve/deployment_mode.ts";

/** what `swamp serve --json` prints once it listens; a supervising host reads it */
export interface ServeListeningLine {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly schedulingEnabled: boolean;
  readonly detachRuns: boolean;
  readonly mode: DeploymentMode;
  readonly authMode: AuthMode;
}

export interface ListenedServe {
  readonly port: number;
  readonly authMode: AuthMode;
}

const AUTH_MODES: ReadonlySet<string> = new Set<AuthMode>([
  "none",
  "token",
  "oauth",
]);

export function formatListeningLine(line: ServeListeningLine): string {
  return JSON.stringify({ status: "listening", ...line });
}

/** null for any line that is not a well-formed listening line */
export function parseListeningLine(line: string): ListenedServe | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { status, port, authMode } = parsed as Record<string, unknown>;
  if (status !== "listening") return null;
  if (typeof port !== "number" || !Number.isInteger(port)) return null;
  if (port <= 0 || port >= 65_536) return null;
  if (typeof authMode !== "string" || !AUTH_MODES.has(authMode)) return null;
  return { port, authMode: authMode as AuthMode };
}
