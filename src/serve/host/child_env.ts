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

import { isAbsolute, resolve } from "@std/path";
import { API_KEY_FILE_ENV } from "../../infrastructure/persistence/api_key_source.ts";
import { SERVE_ENV_MAP } from "../serve_env_map.ts";

// the host terminates TLS and checks readiness over plain http on loopback;
// an empty value outranks a serve.yaml tls: block
const CHILD_TLS_OFF_NAMES = ["SWAMP_SERVE_CERT_FILE", "SWAMP_SERVE_KEY_FILE"];

// the operator's outbound trust, which every serve needs to reach swamp-club
const SHARED_SETTING_NAMES: ReadonlySet<string> = new Set(["SWAMP_CA_CERT"]);

// an env value outranks serve.yaml, so one would set grants, addresses and
// policy for every workspace, unseen by the teams whose serve.yaml it overrides
const SERVE_SETTING_NAMES: readonly string[] = [
  ...Object.values(SERVE_ENV_MAP).filter((name) =>
    !SHARED_SETTING_NAMES.has(name) && !CHILD_TLS_OFF_NAMES.includes(name)
  ),
  "SWAMP_OAUTH_CLIENT_SECRET",
  "SWAMP_OAUTH_CLIENT_SECRET_FILE",
];

const HOST_RELATIVE_PATH_NAMES = [API_KEY_FILE_ENV, "SWAMP_CA_CERT"];

// the first four would point every workspace at one repo, datastore or swamp home
const DROPPED_NAMES: ReadonlySet<string> = new Set([
  "SWAMP_REPO_DIR",
  "SWAMP_DATASTORE",
  "SWAMP_HOME",
  "SWAMP_CONFIG_DIR",
  ...CHILD_TLS_OFF_NAMES,
  ...SERVE_SETTING_NAMES,
]);

export interface PinnedSwampDirs {
  readonly swampHome: string;
  readonly configDir: string;
  /** the host's working directory; a child runs in its own repo folder */
  readonly cwd: string;
}

/**
 * a child inherits the host's environment as plain serve inherits its
 * operator's, but for the names dropped above
 */
export function hostChildEnv(
  hostEnv: Readonly<Record<string, string>>,
  pinned: PinnedSwampDirs,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    // Windows spells names in any case
    if (!DROPPED_NAMES.has(name.toUpperCase())) env[name] = value;
  }
  // the host read these relative to where it was started; a child runs in its repo
  const hostRelative = new Set(HOST_RELATIVE_PATH_NAMES);
  for (const [name, value] of Object.entries(env)) {
    if (
      hostRelative.has(name.toUpperCase()) && value !== "" && !isAbsolute(value)
    ) {
      env[name] = resolve(pinned.cwd, value);
    }
  }
  env.SWAMP_HOME = pinned.swampHome;
  env.SWAMP_CONFIG_DIR = pinned.configDir;
  for (const name of CHILD_TLS_OFF_NAMES) env[name] = "";
  return env;
}

/** the serve settings set in the host's environment that no child is given, sorted */
export function withheldServeSettings(
  hostEnv: Readonly<Record<string, string>>,
): string[] {
  const settings = new Set(SERVE_SETTING_NAMES);
  return Object.keys(hostEnv)
    .filter((name) => settings.has(name.toUpperCase()))
    .sort();
}
