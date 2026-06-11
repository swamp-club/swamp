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

/**
 * Revoke a worker enrollment token before its lifetime expires (see
 * design/remote-execution.md, "Enrollment tokens").
 *
 * Runs the `revoke` method on the existing `swamp/enrollment-token` model
 * instance named by the token. Revoking an already-revoked token is a
 * no-op, reported via `alreadyRevoked`.
 */

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { modelMethodRun, type ModelMethodRunEvent } from "../models/run.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { createWorkerModelRunDeps } from "./run_deps.ts";

/** Data payload for the completed event. */
export interface WorkerTokenRevokeData {
  name: string;
  state: string;
  revokedAt?: string;
  /** True when the token was already revoked and no state change occurred. */
  alreadyRevoked: boolean;
}

export type WorkerTokenRevokeEvent =
  | { kind: "revoking"; name: string }
  | { kind: "completed"; data: WorkerTokenRevokeData }
  | { kind: "error"; error: SwampError };

export interface WorkerTokenRevokeInput {
  name: string;
}

/** Dependencies for the worker token revoke operation. */
export interface WorkerTokenRevokeDeps {
  runRevoke: (name: string) => AsyncIterable<ModelMethodRunEvent>;
}

/** Wires real infrastructure into WorkerTokenRevokeDeps. */
export async function createWorkerTokenRevokeDeps(
  ctx: LibSwampContext,
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<WorkerTokenRevokeDeps> {
  const runDeps = await createWorkerModelRunDeps(repoDir, repoContext);
  return {
    runRevoke: (name) =>
      modelMethodRun(ctx, runDeps, {
        modelIdOrName: name,
        methodName: "revoke",
        inputs: {},
        lastEvaluated: false,
      }),
  };
}

const TOKEN_DATA_NAME = "token-main";

/**
 * Revokes a named enrollment token.
 */
export async function* workerTokenRevoke(
  _ctx: LibSwampContext,
  deps: WorkerTokenRevokeDeps,
  input: WorkerTokenRevokeInput,
): AsyncGenerator<WorkerTokenRevokeEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.token.revoke",
    { "token.name": input.name },
    (async function* () {
      yield { kind: "revoking" as const, name: input.name };

      let tokenRecord: Record<string, unknown> | undefined;
      let completed = false;
      for await (const event of deps.runRevoke(input.name)) {
        if (event.kind === "error") {
          // Reword the generic model lookup failure in token terms.
          const error = event.error.code === "model_not_found"
            ? {
              code: event.error.code,
              message: `Enrollment token '${input.name}' not found. ` +
                "Use 'swamp worker token list' to see existing tokens.",
            }
            : event.error;
          yield { kind: "error" as const, error };
          return;
        }
        if (event.kind === "completed") {
          completed = true;
          tokenRecord = event.run.dataArtifacts.find(
            (artifact) => artifact.name === TOKEN_DATA_NAME,
          )?.attributes;
        }
      }

      if (!completed) {
        yield {
          kind: "error" as const,
          error: {
            code: "revoke_incomplete",
            message: `Revoke of token '${input.name}' ended without completing`,
          },
        };
        return;
      }

      // The revoke method skips the write when the token is already
      // revoked — no token-main artifact means a no-op revocation.
      if (tokenRecord === undefined) {
        yield {
          kind: "completed" as const,
          data: {
            name: input.name,
            state: "revoked",
            alreadyRevoked: true,
          },
        };
        return;
      }

      yield {
        kind: "completed" as const,
        data: {
          name: input.name,
          state: typeof tokenRecord.state === "string"
            ? tokenRecord.state
            : "revoked",
          revokedAt: typeof tokenRecord.revokedAt === "string"
            ? tokenRecord.revokedAt
            : undefined,
          alreadyRevoked: false,
        },
      };
    })(),
  );
}
