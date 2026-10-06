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
 * Environment snapshot for remote dispatch (see design/enablers/remote-execution.md,
 * "The execution environment").
 *
 * The orchestrator snapshots its environment and ships it with every
 * dispatch; the worker overlays it onto its own base environment for the
 * duration of the step. A fixed denylist of process-identity and
 * host-runtime variables is never shipped — those describe *where the
 * process is running*, which is precisely what remote execution changes.
 * The denylist is pinned here and versioned with REMOTE_PROTOCOL_VERSION.
 */

import { NESTED_GATE_PASS_ENV } from "../auth/nested_gate_pass.ts";
import {
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_PID,
  SWAMP_LOCK_HOLDER_TOKENS,
} from "../datastore/lock_holder_marker.ts";

/** An immutable name→value capture of environment variables. */
export type EnvironmentSnapshot = Readonly<Record<string, string>>;

// W3C trace context variables. A process started with these joins that trace.
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
 * denylisted variable. With an `allow` list (serve's `dispatch-env-allow`),
 * only the named variables ship, still minus the denylist; an empty list
 * ships nothing. Names compare case-insensitively, like the denylist.
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
 * Parse serve's comma-separated `dispatch-env-allow` value. Undefined means
 * the option is unset (the full snapshot ships); an empty value is an
 * empty allowlist (nothing ships).
 */
export function parseDispatchEnvAllow(
  raw: string | undefined,
): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((name) => name.trim()).filter((name) =>
    name.length > 0
  );
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
 * Strip inherited W3C trace context (`TRACEPARENT`, `TRACESTATE`, matched
 * case-insensitively) from an environment record. A dispatch runner joins a
 * trace only through its dispatch's own trace headers; context inherited from
 * the worker's environment, or from an orchestrator that still ships it,
 * would put every untraced dispatch into one long-lived trace.
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

/**
 * True when an environment variable is a SWAMP_* runtime variable.
 * Used by {@link createSafeMethodEnv} to strip swamp auth and config
 * vars from the environment inherited by method-spawned child processes.
 */
export function isSwampEnvVar(name: string): boolean {
  return name.toUpperCase().startsWith(SWAMP_PREFIX);
}

/**
 * The SWAMP_* variables a method child may inherit, because a swamp it runs
 * needs them to act as a nested swamp under this one. None is a
 * credential: the account key, its file and its signin token stay stripped
 * (swamp-club#2032).
 *
 * - SWAMP_NESTED_GATE_PASS: this run's signed proof and pid, so a nested
 *   swamp passes the auth gate without a key (design/surfaces/auth-gate.md,
 *   "Nested runs").
 * - SWAMP_LOCK_ANCESTOR_PIDS: the pids of every swamp above the child,
 *   ending with this one, so a nested swamp skips the per-model locks they
 *   hold instead of waiting on them.
 * - SWAMP_LOCK_HOLDER_PID: the pid of the nearest swamp that has taken a
 *   per-model lock (this one once it has, else the value it inherited), for
 *   older nested swamps that read only this name.
 * - SWAMP_LOCK_HOLDER_TOKENS: which of those swamps' locks each holds for
 *   the run that started the child, so it still waits on their other runs'
 *   locks. Inherited here; the shell model adds this run's own entry per
 *   spawn.
 *
 *   All three: design/enablers/datastores.md, "Parent-Process Lock
 *   Awareness". A fitness test pins the list.
 */
export const NESTED_SWAMP_ENV_VARS: readonly string[] = [
  NESTED_GATE_PASS_ENV,
  SWAMP_LOCK_HOLDER_PID,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_TOKENS,
];

/**
 * Build a safe environment for child processes spawned by method code
 * (the shell model, or extension code using Deno.Command directly).
 *
 * Strips all SWAMP_* variables — auth tokens, server URLs, worker
 * credentials, and config overrides — so external tools never inherit
 * swamp's own credentials. Process-identity vars (HOME, PATH, SHELL, …)
 * are preserved because the child runs on the same host.
 *
 * Pass `allow` to opt specific SWAMP_* names back in when a child
 * genuinely needs one (exact, case-sensitive match).
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
