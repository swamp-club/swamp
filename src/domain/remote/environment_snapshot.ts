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

import { NESTED_GATE_PASS_ENV } from "../auth/nested_gate_pass.ts";
import {
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_PID,
  SWAMP_LOCK_HOLDER_TOKENS,
} from "../datastore/lock_holder_marker.ts";

export type EnvironmentSnapshot = Readonly<Record<string, string>>;

const TRACE_CONTEXT_VARS: readonly string[] = ["TRACEPARENT", "TRACESTATE"];

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
  // The orchestrator's own trace context. A dispatch carries its trace
  // explicitly (execution.traceHeaders); an inherited one would put every
  // untraced dispatch into the orchestrator's process trace.
  ...TRACE_CONTEXT_VARS,
]);

const DENYLIST_PREFIXES: readonly string[] = [
  "XDG_",
  "DENO_",
  "SWAMP_",
  // The orchestrator's telemetry identity and exporter settings (service
  // name, collector endpoint and auth headers). A runner exports as the
  // worker host it runs on.
  "OTEL_",
];

/**
 * names compare case-insensitively because Windows environment variable names
 * are
 */
export function isDeniedEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENYLIST_EXACT.has(upper)) {
    return true;
  }
  return DENYLIST_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * an allow list ships only the named variables, still minus the denylist; an
 * empty list ships nothing; names compare case-insensitively
 */
export function captureEnvironmentSnapshot(
  env: Record<string, string>,
  allow?: readonly string[],
): EnvironmentSnapshot {
  const allowed = allow
    ? new Set(allow.map((name) => name.toUpperCase()))
    : undefined;
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (allowed && !allowed.has(name.toUpperCase())) continue;
    if (!isDeniedEnvVar(name)) {
      snapshot[name] = value;
    }
  }
  return snapshot;
}

/**
 * undefined means the option is unset (the full snapshot ships); an empty value
 * is an empty allowlist (nothing ships)
 */
export function parseDispatchEnvAllow(
  raw: string | undefined,
): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((name) => name.trim()).filter((name) =>
    name.length > 0
  );
}

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
 * a runner joins a trace only through its dispatch's own trace headers;
 * inherited context would put every untraced dispatch into one long-lived trace
 */
export function stripInheritedTraceContext(
  env: Record<string, string>,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!TRACE_CONTEXT_VARS.includes(name.toUpperCase())) {
      cleaned[name] = value;
    }
  }
  return cleaned;
}

const SWAMP_PREFIX = "SWAMP_";

export function isSwampEnvVar(name: string): boolean {
  return name.toUpperCase().startsWith(SWAMP_PREFIX);
}

/**
 * SWAMP_* variables a nested swamp needs to act under this one; none is a
 * credential, so the account key, its file and signin token stay stripped; a
 * fitness test pins the list
 */
export const NESTED_SWAMP_ENV_VARS: readonly string[] = [
  NESTED_GATE_PASS_ENV,
  SWAMP_LOCK_HOLDER_PID,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_TOKENS,
];

/**
 * strips all SWAMP_* so external tools never inherit swamp credentials;
 * identity vars (HOME, PATH) stay; allow opts names back in by exact,
 * case-sensitive match
 */
export function createSafeMethodEnv(
  env: Record<string, string>,
  allow?: readonly string[],
): Record<string, string> {
  const allowSet = allow ? new Set(allow) : undefined;
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isSwampEnvVar(name) || allowSet?.has(name)) {
      safe[name] = value;
    }
  }
  return safe;
}

/**
 * the snapshot wins, but denylisted names are dropped even if a non-conforming
 * peer shipped them, so the worker host's own identity values survive
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
