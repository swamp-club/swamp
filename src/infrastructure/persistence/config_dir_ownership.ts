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

import { getSwampConfigDir } from "./paths.ts";

export type StatUid = (path: string) => number | null;

const statUid: StatUid = (path) => Deno.statSync(path).uid;

/**
 * false only when the dir exists and another user owns it, such as a system
 * daemon using the user's config dir, whose root-owned files the user couldn't
 * read back; Windows always owns
 */
export function ownsDirectory(
  dir: string,
  uid: number | null = Deno.uid(),
  stat: StatUid = statUid,
): boolean {
  if (uid === null) return true;
  try {
    const owner = stat(dir);
    return owner === null || owner === uid;
  } catch {
    // Missing: it will be created by this process.
    return true;
  }
}

export function processOwnsConfigDir(): boolean {
  let dir: string;
  try {
    dir = getSwampConfigDir();
  } catch {
    // No HOME at all: there is no dir to leave files in.
    return true;
  }
  return ownsDirectory(dir);
}
