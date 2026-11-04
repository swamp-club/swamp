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

import type { DataRecord } from "../domain/data/data_record.ts";
import {
  type EnrollmentToken,
  enrollmentTokenBindingVerdict,
} from "../domain/models/worker/enrollment_token_model.ts";
import {
  type WorkerState,
  WorkerStateSchema,
} from "../domain/models/worker/worker_model.ts";
import type {
  PoolWorker,
  WorkerPoolReader,
} from "../domain/remote/worker_pool.ts";
import type { WorkerSnapshot } from "./worker_gateway.ts";
import { workerGcListPredicate } from "./worker_gc_service.ts";

export interface ServeWorkerPoolReaderDeps {
  liveWorkers(): readonly WorkerSnapshot[];
  readTokenRecords(): Promise<ReadonlyMap<string, EnrollmentToken>>;
  readWorkerRecords(): Promise<readonly WorkerState[]>;
  now(): number;
}

// enrolledAt stands in for the mint only on records written before tokenCreatedAt
export function leftPoolTokenHolds(
  record: WorkerState,
  token: EnrollmentToken | null,
  nowMs: number,
): boolean {
  if (
    !enrollmentTokenBindingVerdict(
      token,
      record.tokenCreatedAt ?? record.enrolledAt,
    ).keep
  ) {
    return false;
  }
  return token !== null && token.state !== "expired" &&
    Date.parse(token.expiresAt) > nowMs;
}

// no production caller on purpose: the fan-out lane engine is its first
export class ServeWorkerPoolReader implements WorkerPoolReader {
  readonly #deps: ServeWorkerPoolReaderDeps;

  constructor(deps: ServeWorkerPoolReaderDeps) {
    this.#deps = deps;
  }

  async readPool(): Promise<PoolWorker[]> {
    const live = this.#deps.liveWorkers();
    const pool: PoolWorker[] = live.map((worker) => ({
      name: worker.name,
      instanceUuid: worker.instanceUuid,
      labels: { ...worker.labels },
      platform: worker.platform,
      arch: worker.arch,
      status: worker.status,
      connected: worker.connected,
    }));
    const names = new Set(live.map((worker) => worker.name));
    const records = (await this.#deps.readWorkerRecords())
      .filter((record) => !names.has(record.name));
    if (records.length === 0) return pool;
    const tokens = await this.#deps.readTokenRecords();
    const nowMs = this.#deps.now();
    for (const record of records) {
      // two records under one name: the first that holds wins
      if (names.has(record.name)) continue;
      const token = tokens.get(record.tokenName) ?? null;
      if (!leftPoolTokenHolds(record, token, nowMs)) continue;
      names.add(record.name);
      pool.push({
        name: record.name,
        instanceUuid: record.instanceUuid,
        labels: { ...record.labels },
        platform: record.platform,
        arch: record.arch,
        status: record.status === "unverified" || record.status === "draining"
          ? record.status
          : "disconnected",
        connected: false,
      });
    }
    return pool;
  }
}

export function parseWorkerRecords(
  records: readonly Pick<DataRecord, "attributes">[],
): WorkerState[] {
  return records.flatMap((record) => {
    const parsed = WorkerStateSchema.safeParse(record.attributes);
    return parsed.success ? [parsed.data] : [];
  });
}

export function createServeWorkerPoolReader(options: {
  gateway: {
    workers(): WorkerSnapshot[];
    readTokenRecords(): Promise<Map<string, EnrollmentToken>>;
  };
  query(
    predicate: string,
    options: { loadAttributes: true },
  ): Promise<unknown[]>;
  // scopes the record query so another namespace's workers never join
  namespace: string;
  now?: () => number;
}): ServeWorkerPoolReader {
  return new ServeWorkerPoolReader({
    liveWorkers: () => options.gateway.workers(),
    readTokenRecords: () => options.gateway.readTokenRecords(),
    readWorkerRecords: async () =>
      parseWorkerRecords(
        await options.query(workerGcListPredicate(options.namespace), {
          loadAttributes: true,
        }) as DataRecord[],
      ),
    now: options.now ?? Date.now,
  });
}
