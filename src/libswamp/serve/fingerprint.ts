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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  FingerprintCollector,
  type FingerprintCollectorPorts,
  type FingerprintWorkerFacts,
} from "../../domain/serve/fingerprint_collector.ts";
import type { FingerprintProps } from "../../domain/serve/fingerprint.ts";
import {
  WORKER_MODEL_TYPE,
  WorkerStateSchema,
} from "../../domain/models/worker/worker_model.ts";

const WORKER_STATE_DATA_NAME = "state-main";

export interface ServeFingerprintData {
  readonly fingerprint: FingerprintProps;
  readonly hash: string;
}

export type ServeFingerprintEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ServeFingerprintData }
  | { kind: "error"; error: SwampError };

export interface ServeFingerprintDeps
  extends Omit<FingerprintCollectorPorts, "workers"> {
  /** a data query over this repository */
  queryData(predicate: string): Promise<DataRecord[]>;
}

// every worker record counts, whatever its status, so a restart leaves the pool unchanged
async function workerFacts(
  deps: ServeFingerprintDeps,
): Promise<FingerprintWorkerFacts[]> {
  const records = await deps.queryData(
    `modelType == "${WORKER_MODEL_TYPE.normalized}" && ` +
      `name == "${WORKER_STATE_DATA_NAME}"`,
  );
  const facts: FingerprintWorkerFacts[] = [];
  for (const record of records) {
    const parsed = WorkerStateSchema.safeParse(record.attributes);
    if (!parsed.success) continue;
    facts.push({
      swampVersion: parsed.data.swampVersion,
      labelKeys: Object.keys(parsed.data.labels),
    });
  }
  return facts;
}

export async function* serveFingerprint(
  _ctx: LibSwampContext,
  deps: ServeFingerprintDeps,
): AsyncGenerator<ServeFingerprintEvent> {
  yield* withGeneratorSpan(
    "swamp.serve.fingerprint",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const collector = new FingerprintCollector({
          ...deps,
          workers: () => workerFacts(deps),
        });
        const fingerprint = await collector.collect();
        yield {
          kind: "completed" as const,
          data: { fingerprint: fingerprint.toJSON(), hash: fingerprint.hash() },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "serve_fingerprint_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
