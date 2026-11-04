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

import { join } from "@std/path";
import {
  type AppDependencies,
  appDependencySpecifiers,
  BUN_LOCKFILE,
  OTHER_APP_LOCKFILES,
} from "@swamp-club/extension-scoring/dependency-audit";

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The app folder's packages, as the registry reads them from the archive. */
export async function readAppDependencies(
  appDir: string,
  label: string,
): Promise<AppDependencies> {
  const otherLockfiles: string[] = [];
  for (const name of OTHER_APP_LOCKFILES) {
    if (await isFile(join(appDir, name))) otherLockfiles.push(name);
  }
  const packageJsonPath = join(appDir, "package.json");
  const bunLockPath = join(appDir, BUN_LOCKFILE);
  return appDependencySpecifiers(
    {
      packageJson: await readTextOrNull(packageJsonPath),
      bunLock: await readTextOrNull(bunLockPath),
      otherLockfiles,
    },
    label,
    packageJsonPath,
    bunLockPath,
  );
}
