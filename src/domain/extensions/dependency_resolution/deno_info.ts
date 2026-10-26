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
 * `deno info --json`, the one way swamp asks Deno for an extension's module
 * graph (swamp-club#3969). Each caller passes the project flags its read
 * needs; Deno, not swamp, decides how a config, an import map, its scopes, a
 * workspace and node_modules resolve each import.
 */

/** Upper bound on one `deno info` run; it fetches remote modules on a cold cache. */
export const DENO_INFO_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * What `deno info --json` answers for one root: the raw output, read by the
 * graph parsers, and the exact versions Deno resolved each `npm:` and `jsr:`
 * specifier to, which it reports as `redirects` and `npmPackages`.
 */
export interface DenoModuleGraph {
  json: unknown;
  /** Each specifier Deno redirected, to what it redirected it. */
  redirects: Record<string, string>;
  /** Each npm package Deno resolved (`name@version`), as Deno reports it. */
  npmPackages: Record<string, unknown>;
}

/** A `deno info` run: its graph, or why it failed. */
export type DenoInfoResult =
  | { success: true; graph: DenoModuleGraph }
  | { success: false; code: number; stderr: string };

/** How to run `deno info`. */
export interface DenoInfoOptions {
  /** The project flags, from `denoProjectArgs`, and any others. */
  args: readonly string[];
  env?: Record<string, string>;
  /** The working directory; the caller's when absent. */
  cwd?: string;
  /** Cancels the run; a five-minute timeout when absent. */
  signal?: AbortSignal;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Runs `deno info --json <args> <root>`. `root` is a file URL, not a path:
 * deno info resolves its argument through the import map first, which reads
 * a Windows path (C:\...) as a URL with the scheme c:. Output that is not
 * JSON throws, naming `label`.
 */
export async function runDenoInfo(
  denoPath: string,
  root: string,
  label: string,
  options: DenoInfoOptions,
): Promise<DenoInfoResult> {
  const output = await new Deno.Command(denoPath, {
    args: ["info", "--json", ...options.args, root],
    stdout: "piped",
    stderr: "piped",
    signal: options.signal ?? AbortSignal.timeout(DENO_INFO_TIMEOUT_MS),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  }).output();
  if (!output.success) {
    return {
      success: false,
      code: output.code,
      stderr: new TextDecoder().decode(output.stderr),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(output.stdout));
  } catch (error) {
    throw new Error(`deno info returned invalid JSON for ${label}: ${error}`);
  }
  const body = recordOf(json);
  const redirects: Record<string, string> = {};
  for (const [from, to] of Object.entries(recordOf(body.redirects))) {
    if (typeof to === "string") redirects[from] = to;
  }
  return {
    success: true,
    graph: { json, redirects, npmPackages: recordOf(body.npmPackages) },
  };
}
