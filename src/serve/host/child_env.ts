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

// the host terminates TLS and checks readiness over plain http on loopback;
// an empty value outranks a serve.yaml tls: block
const CHILD_TLS_OFF_NAMES = ["SWAMP_SERVE_CERT_FILE", "SWAMP_SERVE_KEY_FILE"];

// each names one serve's grants, address, webhook routes or OAuth client, and
// would outrank every workspace's own serve.yaml
const PER_SERVE_NAMES: readonly string[] = [
  "SWAMP_GRANTS_FILE",
  "SWAMP_GRANTS_DIR",
  "SWAMP_SERVE_ADVERTISE_ADDRESS",
  "SWAMP_WEBHOOK_ROUTES_DIR",
  "SWAMP_OAUTH_CLIENT_ID",
  "SWAMP_OAUTH_CLIENT_NAME",
  "SWAMP_OAUTH_CLIENT_SECRET",
  "SWAMP_OAUTH_CLIENT_SECRET_FILE",
];

// each would point every workspace at one repo, datastore or swamp home
const DROPPED_NAMES: ReadonlySet<string> = new Set([
  "SWAMP_REPO_DIR",
  "SWAMP_DATASTORE",
  "SWAMP_HOME",
  "SWAMP_CONFIG_DIR",
  ...CHILD_TLS_OFF_NAMES,
  ...PER_SERVE_NAMES,
]);

export interface PinnedSwampDirs {
  readonly swampHome: string;
  readonly configDir: string;
  /** the host's working directory; a child runs in its own repo folder */
  readonly cwd: string;
}

/**
 * a child inherits the host's environment as plain serve inherits its
 * operator's, so models, workers and env-set serve settings see what they
 * would see under plain serve
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
  // the host signed in with this file, relative to where it was started
  const keyFile = env[API_KEY_FILE_ENV];
  if (keyFile !== undefined && keyFile !== "" && !isAbsolute(keyFile)) {
    env[API_KEY_FILE_ENV] = resolve(pinned.cwd, keyFile);
  }
  env.SWAMP_HOME = pinned.swampHome;
  env.SWAMP_CONFIG_DIR = pinned.configDir;
  for (const name of CHILD_TLS_OFF_NAMES) env[name] = "";
  return env;
}

/** the per-serve settings the host holds back from every child, sorted */
export function withheldServeSettings(
  hostEnv: Readonly<Record<string, string>>,
): string[] {
  const perServe = new Set(PER_SERVE_NAMES);
  return Object.keys(hostEnv)
    .filter((name) => perServe.has(name.toUpperCase()))
    .sort();
}
