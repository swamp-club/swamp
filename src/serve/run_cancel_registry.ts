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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["serve", "cancel-registry"]);

export type ExecutionType = "workflow-run" | "method-run";

export interface RunCancelEntry {
  executionType: ExecutionType;
  executionId: string;
  controller: AbortController;
  registeredAt: Date;
}

export class RunCancelRegistry {
  private readonly entries = new Map<string, RunCancelEntry>();

  private key(type: ExecutionType, id: string): string {
    return `${type}:${id}`;
  }

  register(
    executionType: ExecutionType,
    executionId: string,
    controller: AbortController,
  ): void {
    const k = this.key(executionType, executionId);
    this.entries.set(k, {
      executionType,
      executionId,
      controller,
      registeredAt: new Date(),
    });
    logger.debug`Registered ${executionType} ${executionId}`;
  }

  deregister(executionType: ExecutionType, executionId: string): void {
    const k = this.key(executionType, executionId);
    if (this.entries.delete(k)) {
      logger.debug`Deregistered ${executionType} ${executionId}`;
    }
  }

  cancel(executionType: ExecutionType, executionId: string): boolean {
    const k = this.key(executionType, executionId);
    const entry = this.entries.get(k);
    if (!entry) {
      return false;
    }
    logger.info`Cancelling ${executionType} ${executionId}`;
    entry.controller.abort(new Error("cancelled by user"));
    return true;
  }

  cancelAll(executionType?: ExecutionType): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (executionType && entry.executionType !== executionType) {
        continue;
      }
      logger.info`Cancelling ${entry.executionType} ${entry.executionId}`;
      entry.controller.abort(new Error("cancelled by user"));
      count++;
    }
    return count;
  }

  list(executionType?: ExecutionType): ReadonlyArray<RunCancelEntry> {
    const result: RunCancelEntry[] = [];
    for (const entry of this.entries.values()) {
      if (executionType && entry.executionType !== executionType) {
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  get size(): number {
    return this.entries.size;
  }
}
