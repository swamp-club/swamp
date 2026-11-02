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

/** Upper bound on one `deno info` run; it fetches remote modules on a cold cache. */
export const DENO_INFO_TIMEOUT_MS = 5 * 60 * 1000;

export interface DenoModuleGraph {
  json: unknown;
  redirects: Record<string, string>;
  npmPackages: Record<string, unknown>;
}

export type DenoInfoResult =
  | { success: true; graph: DenoModuleGraph }
  | { success: false; code: number; stderr: string };

export interface DenoInfoOptions {
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * root is a file URL, not a path: deno info resolves its argument through the
 * import map, which reads a Windows path (C:\...) as a URL with scheme c:
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
