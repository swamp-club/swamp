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

import type { RetentionPolicy } from "../../domain/retention/retention_policy.ts";
import type {
  RetentionWatermark,
  RetentionWatermarkRepository,
} from "../../domain/retention/retention_watermark.ts";
import type { RetentionKind } from "../../domain/retention/retention_policy.ts";
import {
  createRetentionCollectors,
  type RetentionCollectorSources,
} from "./collectors.ts";
import {
  type RetentionPassOptions,
  type RetentionPassResult,
  runRetentionPass,
} from "./pass.ts";

export interface RepoRetentionDeps extends RetentionCollectorSources {
  watermarks?: RetentionWatermarkRepository;
  runBatch<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs once after the batches: v3 history compaction, catalog checkpoint.
   * Its failure is logged, never thrown.
   */
  afterPass?(result: RetentionPassResult): Promise<void>;
}

class DiscardedWatermarks implements RetentionWatermarkRepository {
  get(_kind: RetentionKind): Promise<RetentionWatermark | null> {
    return Promise.resolve(null);
  }
  getAll(): Promise<RetentionWatermark[]> {
    return Promise.resolve([]);
  }
  put(_watermark: RetentionWatermark): Promise<void> {
    return Promise.resolve();
  }
  claimHourlyPass(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export async function runRepoRetention(
  deps: RepoRetentionDeps,
  options: RetentionPassOptions & { policy: RetentionPolicy },
): Promise<RetentionPassResult> {
  const collectors = createRetentionCollectors(deps, options.policy);
  return await runRetentionPass(
    {
      collectors,
      watermarks: deps.watermarks ?? new DiscardedWatermarks(),
      runBatch: deps.runBatch,
      afterPass: deps.afterPass,
      now: () => new Date(deps.now?.() ?? Date.now()),
    },
    options,
  );
}
