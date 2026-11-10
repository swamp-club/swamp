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
 * the auth gate reads credentials from the caller's swamp config, so the
 * config-location and credential variables pass through untouched
 */
const KEPT_SWAMP_VARS: ReadonlySet<string> = new Set([
  "SWAMP_HOME",
  "SWAMP_CONFIG_DIR",
  "SWAMP_API_KEY",
  "SWAMP_API_KEY_FILE",
  "SWAMP_SIGNIN_TOKEN",
  "SWAMP_CLUB_URL",
]);

export const CHILD_SWITCHES: Readonly<Record<string, string>> = {
  SWAMP_NO_TELEMETRY: "1",
  SWAMP_NO_UPDATE_CHECK: "1",
  SWAMP_NO_INBOX_NOTICE: "1",
};

/** the root help lists this code for an unknown command */
export const UNKNOWN_COMMAND_EXIT = 2;

export const PREFLIGHT_ARGS: readonly string[] = [
  "swamp-preflight-unknown-command",
];

function dropped(name: string): boolean {
  // option defaults such as SWAMP_REPO_DIR or SWAMP_SERVE_URL would point a
  // run at another repo or server
  if (name.startsWith("SWAMP_")) return !KEPT_SWAMP_VARS.has(name);
  return name.startsWith("OTEL_") || name === "TRACEPARENT" ||
    name === "TRACESTATE";
}

export function childEnv(
  base: Readonly<Record<string, string>>,
  tmpDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (!dropped(name)) env[name] = value;
  }
  return { ...env, ...CHILD_SWITCHES, TMPDIR: tmpDir };
}

/**
 * an unknown command is gated, so any exit other than the unknown-command code
 * means the gate refused the run before Cliffy could answer
 */
export function preflightRefusal(
  binary: string,
  exitCode: number,
  stderr: string,
): string | undefined {
  if (exitCode === UNKNOWN_COMMAND_EXIT) return undefined;
  return [
    `${binary}: an unknown command exited ${exitCode}, not ${UNKNOWN_COMMAND_EXIT}.`,
    "The auth gate most likely refused it. Run `swamp auth login`, then retry.",
    "",
    stderr.trim(),
  ].join("\n");
}

export async function preflight(
  binary: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  const { code, stderr } = await new Deno.Command(binary, {
    args: [...PREFLIGHT_ARGS],
    cwd,
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    signal: AbortSignal.timeout(timeoutMs),
  }).output();
  const refusal = preflightRefusal(
    binary,
    code,
    new TextDecoder().decode(stderr),
  );
  if (refusal !== undefined) throw new Error(refusal);
}
