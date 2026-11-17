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
import { NESTED_GATE_PASS_ENV } from "../../domain/auth/nested_gate_pass.ts";
import {
  API_KEY_ENV,
  API_KEY_FILE_ENV,
} from "../../infrastructure/persistence/api_key_source.ts";
import { SIGNIN_TOKEN_ENV } from "../../infrastructure/persistence/auth_verification_repository.ts";
import { TELEMETRY_OPT_OUT_ENV_VARS } from "../../infrastructure/telemetry/telemetry_opt_out_env.ts";

const KEPT_NAMES: ReadonlySet<string> = new Set([
  // an operator's telemetry opt-out holds for every child
  ...TELEMETRY_OPT_OUT_ENV_VARS,
  // a child is a serve the operator would otherwise start with these itself;
  // serve strips them again from the method children that run extension code
  API_KEY_ENV,
  API_KEY_FILE_ENV,
  SIGNIN_TOKEN_ENV,
  // bound to the host's pid, and the host is each child's parent
  NESTED_GATE_PASS_ENV,
  // a credential is only good at the swamp-club that issued it
  "SWAMP_CLUB_URL",
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
  /** the host's working directory; a child runs in its own repo folder */
  readonly cwd: string;
}

/**
 * a child gets only what it needs to run, sign in and reach the network; a
 * SWAMP_SERVE_* setting the host was started with, or SWAMP_REPO_DIR,
 * SWAMP_TRUSTED_HOSTS or SWAMP_DATASTORE, would override what the host or each
 * repo decides for its child, so none passes through
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
  const keyFile = env[API_KEY_FILE_ENV];
  if (keyFile !== undefined && keyFile !== "" && !isAbsolute(keyFile)) {
    env[API_KEY_FILE_ENV] = resolve(pinned.cwd, keyFile);
  }
  env.SWAMP_HOME = pinned.swampHome;
  env.SWAMP_CONFIG_DIR = pinned.configDir;
  return env;
}
