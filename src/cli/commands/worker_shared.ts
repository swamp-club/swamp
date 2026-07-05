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

import { UserError } from "../../domain/errors.ts";

export function parseLabels(
  labelFlags: string[] | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const flag of labelFlags ?? []) {
    const eq = flag.indexOf("=");
    if (eq <= 0 || eq === flag.length - 1) {
      throw new UserError(
        `Invalid label '${flag}' — expected the form key=value`,
      );
    }
    labels[flag.slice(0, eq)] = flag.slice(eq + 1);
  }
  return labels;
}
