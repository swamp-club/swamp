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

import type { LazyHydration } from "./lazy_hydration.ts";

export interface FakeCalls {
  paths: { absPath: string; signal: AbortSignal }[];
  partitions: { namespace: string; partition: string }[];
  drains: number[];
}

export function fakeLazyHydration(
  options: {
    /** a Set is shared, so a test may owe paths it learns later */
    owedPaths?: readonly string[] | Set<string>;
    owed?: number;
    perDrain?: number;
    /** writes the file, as the read model's guarded write would */
    onHydrate?: (absPath: string) => Promise<void>;
  } = {},
): LazyHydration & { calls: FakeCalls } {
  const owedPaths = options.owedPaths instanceof Set
    ? options.owedPaths
    : new Set(options.owedPaths ?? []);
  let owed = options.owed ?? owedPaths.size;
  const calls: FakeCalls = { paths: [], partitions: [], drains: [] };
  return {
    calls,
    hydrateOwedPath: async (absPath, signal) => {
      calls.paths.push({ absPath, signal });
      if (!owedPaths.has(absPath)) return "not_owed";
      await options.onHydrate?.(absPath);
      owedPaths.delete(absPath);
      owed--;
      return "hydrated";
    },
    hydrateOwedPartition: (namespace, partition) => {
      calls.partitions.push({ namespace, partition });
      return Promise.resolve(1);
    },
    drainOwed: (budgetMs) => {
      calls.drains.push(budgetMs);
      const hydrated = Math.min(owed, options.perDrain ?? owed);
      owed -= hydrated;
      return Promise.resolve({ hydrated, left: owed });
    },
    owedCount: () => owed,
  };
}
