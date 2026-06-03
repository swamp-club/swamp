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

import type { LibSwampContext } from "./context.ts";
import type { SwampError } from "./errors.ts";

/**
 * Data structure for the version output.
 */
export interface VersionData {
  version: string;
}

export type VersionEvent =
  | { kind: "completed"; data: VersionData }
  | { kind: "error"; error: SwampError };

/** Input for the version operation. */
export interface VersionInput {
  version: string;
}

/** Dependencies for the version operation (none needed). */
export type VersionDeps = Record<string, never>;

/** Creates empty deps for the version operation. */
export function createVersionDeps(): VersionDeps {
  return {} as VersionDeps;
}

/** Returns the current swamp version. */
export async function* version(
  _ctx: LibSwampContext,
  _deps: VersionDeps,
  input: VersionInput,
): AsyncIterable<VersionEvent> {
  const data: VersionData = {
    version: input.version,
  };

  yield { kind: "completed", data };
}
