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
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { VaultService } from "../../domain/vaults/vault_service.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  type EnrollmentToken,
  EnrollmentTokenSchema,
} from "../../domain/models/worker/enrollment_token_model.ts";

const TOKEN_DATA_NAME = "token-main";

function escapeCelString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface WorkerTokenRevealData {
  name: string;
  /** the current credential `<name>.<secret>` */
  token: string;
  expiresAt: string;
  expired: boolean;
}

export type WorkerTokenRevealEvent =
  | { kind: "resolving"; name: string }
  | { kind: "completed"; data: WorkerTokenRevealData }
  | { kind: "error"; error: SwampError };

export interface WorkerTokenRevealDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
  readSecret: (vaultName: string, secretKey: string) => Promise<string>;
}

export function createWorkerTokenRevealDeps(
  dataQueryService: DataQueryService,
  vaultService: VaultService,
): WorkerTokenRevealDeps {
  return {
    query: async (predicate) =>
      await dataQueryService.query(predicate, {
        loadAttributes: true,
      }) as DataRecord[],
    readSecret: (vaultName, secretKey) =>
      vaultService.get(vaultName, secretKey, "worker:token-reveal"),
  };
}

/** a re-mint reuses the name, so the newest mint is the live token */
function newestToken(records: DataRecord[]): EnrollmentToken | undefined {
  let newest: EnrollmentToken | undefined;
  for (const record of records) {
    const parsed = EnrollmentTokenSchema.safeParse(record.attributes);
    if (!parsed.success) continue;
    if (
      newest === undefined ||
      Date.parse(parsed.data.createdAt) > Date.parse(newest.createdAt)
    ) {
      newest = parsed.data;
    }
  }
  return newest;
}

export async function* workerTokenReveal(
  _ctx: LibSwampContext,
  deps: WorkerTokenRevealDeps,
  name: string,
): AsyncGenerator<WorkerTokenRevealEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.token.reveal",
    { "token.name": name },
    (async function* () {
      yield { kind: "resolving" as const, name };

      let records: DataRecord[];
      try {
        records = await deps.query(
          `modelType == "${ENROLLMENT_TOKEN_MODEL_TYPE.normalized}" && ` +
            `name == "${TOKEN_DATA_NAME}" && ` +
            `modelName == "${escapeCelString(name)}"`,
        );
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "token_query_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        return;
      }

      const token = newestToken(records);
      if (token === undefined) {
        yield {
          kind: "error" as const,
          error: {
            code: "token_not_found",
            message: `Enrollment token '${name}' not found. ` +
              "Use 'swamp worker token list' to see existing tokens.",
          },
        };
        return;
      }
      if (token.state === "revoked") {
        yield {
          kind: "error" as const,
          error: {
            code: "token_revoked",
            message: `Enrollment token '${name}' has been revoked`,
          },
        };
        return;
      }

      let secret: string;
      try {
        secret = await deps.readSecret(token.vaultName, token.secretKey);
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "vault_read_failed",
            message:
              `Failed to read the secret for enrollment token '${name}' from vault '${token.vaultName}': ${
                error instanceof Error ? error.message : String(error)
              }`,
          },
        };
        return;
      }

      yield {
        kind: "completed" as const,
        data: {
          name,
          token: `${name}.${secret}`,
          expiresAt: token.expiresAt,
          expired: token.state === "expired" ||
            Date.parse(token.expiresAt) <= Date.now(),
        },
      };
    })(),
  );
}
