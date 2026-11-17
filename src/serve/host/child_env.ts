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

import { TELEMETRY_OPT_OUT_ENV_VARS } from "../../infrastructure/telemetry/telemetry_opt_out_env.ts";

const KEPT_NAMES: ReadonlySet<string> = new Set([
  // an operator's telemetry opt-out holds for every child
  ...TELEMETRY_OPT_OUT_ENV_VARS,
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DENO_CERT",
  "DENO_TLS_CA_STORE",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "PATHEXT",
  "COMSPEC",
]);

const KEPT_PREFIXES = ["LC_", "OTEL_"];

export interface PinnedSwampDirs {
  readonly swampHome: string;
  readonly configDir: string;
}

/**
 * a child gets only what it needs to run and reach the network; any other
 * SWAMP_* setting the host was started with, such as SWAMP_SERVE_AUTH_MODE,
 * would override what the host decides for its children, so none passes through
 */
export function hostChildEnv(
  hostEnv: Readonly<Record<string, string>>,
  pinned: PinnedSwampDirs,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    // names compare without case: Windows spells them as it likes, and the
    // proxy variables are set in both cases on Unix
    const upper = name.toUpperCase();
    if (
      KEPT_NAMES.has(upper) ||
      KEPT_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ) {
      env[name] = value;
    }
  }
  env.SWAMP_HOME = pinned.swampHome;
  env.SWAMP_CONFIG_DIR = pinned.configDir;
  return env;
}
