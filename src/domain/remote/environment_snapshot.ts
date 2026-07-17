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
 * Environment snapshot for remote dispatch (see design/remote-execution.md,
 * "The execution environment").
 *
 * The orchestrator snapshots its environment and ships it with every
 * dispatch; the worker overlays it onto its own base environment for the
 * duration of the step. A fixed denylist of process-identity and
 * host-runtime variables is never shipped — those describe *where the
 * process is running*, which is precisely what remote execution changes.
 * The denylist is pinned here and versioned with REMOTE_PROTOCOL_VERSION.
 */

/** An immutable name→value capture of environment variables. */
export type EnvironmentSnapshot = Readonly<Record<string, string>>;

// Worker control-plane credentials that must never reach a dispatch runner.
// Canonical sources: collectWorkerEnv (worker_daemon.ts), worker_connect.ts.
const WORKER_CREDENTIAL_VARS: ReadonlySet<string> = new Set([
  "SWAMP_WORKER_TOKEN",
  "SWAMP_SERVER_TOKEN",
  "SWAMP_ORCHESTRATOR_URL",
]);

const DENYLIST_EXACT: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "LOGNAME",
  "SHELL",
  "PATH",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOSTNAME",
  "TERM",
]);

const DENYLIST_PREFIXES: readonly string[] = [
  "XDG_",
  "DENO_",
  "SWAMP_",
];

/**
 * True when an environment variable must never be shipped to a worker.
 * Names compare case-insensitively because Windows environment variable
 * names are case-insensitive.
 */
export function isDeniedEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENYLIST_EXACT.has(upper)) {
    return true;
  }
  return DENYLIST_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Capture a shippable snapshot of the given environment, dropping every
 * denylisted variable.
 */
export function captureEnvironmentSnapshot(
  env: Record<string, string>,
): EnvironmentSnapshot {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isDeniedEnvVar(name)) {
      snapshot[name] = value;
    }
  }
  return snapshot;
}

/**
 * Strip worker control-plane credentials from an environment record so they
 * are not inherited by dispatch runner child processes.
 */
export function stripWorkerCredentials(
  env: Record<string, string>,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!WORKER_CREDENTIAL_VARS.has(name)) {
      cleaned[name] = value;
    }
  }
  return cleaned;
}

/**
 * Overlay a shipped snapshot onto a worker's base environment. The snapshot
 * wins for every variable it carries; denylisted names are dropped even if a
 * (non-conforming) peer shipped them, so the worker host's own values always
 * survive for process-identity variables.
 */
export function overlayEnvironment(
  base: Record<string, string>,
  snapshot: EnvironmentSnapshot,
): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(snapshot)) {
    if (!isDeniedEnvVar(name)) {
      merged[name] = value;
    }
  }
  return merged;
}
