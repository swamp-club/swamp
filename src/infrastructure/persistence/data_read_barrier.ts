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

import { processRuntimeSlot } from "../runtime/process_runtime.ts";

/**
 * brings the read model up before a read inside a command whose read model
 * applies only part of the feed; none is set outside such a command
 */
export interface DataReadBarrier {
  /** whether any datastore this process reads applies only part of its feed */
  active(): boolean;
  /** before an async read of one behavior's data */
  beforeModelRead(modelType: string, modelId: string): Promise<void>;
  /** before an async read across behaviors: the catalog, every behavior's data */
  beforeWideRead(): Promise<void>;
  /** a sync read of one behavior's data, which no barrier may precede */
  assertModelReadable(modelType: string, modelId: string): void;
  assertWideReadable(): void;
}

const slot = processRuntimeSlot<{ barrier: DataReadBarrier | undefined }>(
  () => ({ barrier: undefined }),
);

export function setDataReadBarrier(barrier: DataReadBarrier | undefined): void {
  slot().barrier = barrier;
}

export function dataReadBarrier(): DataReadBarrier | undefined {
  return slot().barrier;
}
