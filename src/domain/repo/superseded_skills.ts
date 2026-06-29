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
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "repo", "skills"]);

export const SUPERSEDED_SKILLS: readonly string[] = [
  "swamp-extension-model",
  "swamp-extension-vault",
  "swamp-extension-driver",
  "swamp-extension-datastore",
  "swamp-extension-quality",
  "swamp-data-query",
  "swamp-model",
  "swamp-workflow",
  "swamp-data",
  "swamp-vault",
  "swamp-extension",
  "swamp-extension-publish",
  "swamp-repo",
  "swamp-report",
  "swamp-troubleshooting",
  "swamp-issue",
];

export async function removeSupersededSkills(
  skillsDir: string,
): Promise<void> {
  for (const name of SUPERSEDED_SKILLS) {
    const dir = join(skillsDir, name);
    try {
      await Deno.remove(dir, { recursive: true });
      logger.info`Removed superseded skill ${name}`;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}

export async function detectSupersededSkills(
  skillsDir: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const name of SUPERSEDED_SKILLS) {
    try {
      await Deno.stat(join(skillsDir, name));
      found.push(name);
    } catch {
      // Not found — not stale
    }
  }
  return found;
}
