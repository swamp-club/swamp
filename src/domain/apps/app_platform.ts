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

import { z } from "zod";

/** Where serve answers for the app platform: `/app-platform/<major>/<file>`. */
export const APP_PLATFORM_PATH = "/app-platform";

/** A build's dev build and declarations, packed for authoring an app. */
export const AUTHORING_ARCHIVE = "authoring.tar.gz";

/** Where each packed folder of a build lands in an app's `.swamp-platform/`. */
export function authoringFolders(
  major: number,
): Readonly<Record<string, string>> {
  return {
    dev: `platform/${major}/dev`,
    "types/ui": "ui",
    "types/node_modules": "node_modules",
  };
}

/** The platform an app was built for; `1.4` asks for something added in 1.4. */
export interface PlatformRequirement {
  readonly major: number;
  readonly minor: number;
}

/** A platform this swamp carries, as its build's `platform.json` names it. */
export interface HeldPlatform {
  readonly major: number;
  readonly minor: number;
}

export const PlatformFieldSchema = z.union([
  z.number().int().min(1).max(999),
  z.string().regex(
    /^[1-9]\d{0,2}(\.\d{1,4})?$/,
    'A platform is a major, like 1, or a minimum minor, like "1.4".',
  ),
]);

export function platformRequirement(
  field: z.infer<typeof PlatformFieldSchema>,
): PlatformRequirement {
  const [major, minor = "0"] = String(field).split(".");
  return { major: Number(major), minor: Number(minor) };
}

export function formatRequirement(requirement: PlatformRequirement): string {
  return requirement.minor === 0
    ? String(requirement.major)
    : `${requirement.major}.${requirement.minor}`;
}

/** Why this swamp cannot run an app built for `requirement`, or null if it can. */
export function platformRefusal(
  requirement: PlatformRequirement,
  held: readonly HeldPlatform[],
): string | null {
  if (held.length === 0) {
    return `It needs app platform ${
      formatRequirement(requirement)
    }, and this swamp build has no app platform (it was built without one). Use a released swamp, or build the app platform and then swamp.`;
  }
  const match = held.find((p) => p.major === requirement.major);
  if (match === undefined) {
    const newest = held.reduce<number | null>(
      (top, p) => top === null || p.major > top ? p.major : top,
      null,
    );
    return newest !== null && newest > requirement.major
      ? `It was built for app platform ${requirement.major}, which this swamp no longer serves. Rebuild it against platform ${newest}.`
      : `It needs app platform ${requirement.major}, which this swamp does not have. Upgrade swamp.`;
  }
  if (match.minor < requirement.minor) {
    return `It needs app platform ${
      formatRequirement(requirement)
    }, and this swamp has ${match.major}.${match.minor}. Upgrade swamp.`;
  }
  return null;
}
