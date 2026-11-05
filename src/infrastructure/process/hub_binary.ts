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

import { basename, dirname, isAbsolute, join } from "@std/path";

export interface HubBinaries {
  /** the Go hub, `swampd` */
  readonly hub: string;
  /** the swamp executable the hub starts as its engines */
  readonly engine: string;
}

export interface HubBinaryDeps {
  env(name: string): string | undefined;
  execPath(): string;
  isFile(path: string): Promise<boolean>;
  readonly os: typeof Deno.build.os;
}

const defaultDeps: HubBinaryDeps = {
  env: (name) => Deno.env.get(name),
  execPath: () => Deno.execPath(),
  isFile: async (path) => {
    try {
      return (await Deno.stat(path)).isFile;
    } catch {
      return false;
    }
  },
  os: Deno.build.os,
};

/**
 * The Go hub and the engine it should run, or null when this install has no
 * hub: then `swamp start` and `swamp dashboard` keep their own local hub.
 * A swamp run from source is `deno`, which the hub can't start as an engine.
 */
export async function locateHubBinaries(
  deps: HubBinaryDeps = defaultDeps,
): Promise<HubBinaries | null> {
  const exe = deps.os === "windows" ? ".exe" : "";
  const execPath = deps.execPath();
  const engine = deps.env("SWAMP_HUB_ENGINE") ??
    (/^deno(\.exe)?$/i.test(basename(execPath)) ? undefined : execPath);
  if (engine === undefined || !isAbsolute(engine)) return null;
  const hub = deps.env("SWAMPD_BINARY") ??
    join(dirname(engine), `swampd${exe}`);
  if (!isAbsolute(hub)) return null;
  if (!await deps.isFile(hub) || !await deps.isFile(engine)) return null;
  return { hub, engine };
}
