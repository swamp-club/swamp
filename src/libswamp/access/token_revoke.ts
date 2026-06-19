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
 * Revoke a server token before its lifetime expires.
 *
 * Runs the `revoke` method on the existing `swamp/server-token` model
 * instance named by the token. Revoking an already-revoked token is a
 * no-op, reported via `alreadyRevoked`.
 */

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { modelMethodRun, type ModelMethodRunEvent } from "../models/run.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { createServerTokenRunDeps } from "./run_deps.ts";

export interface ServerTokenRevokeData {
  name: string;
  state: string;
  revokedAt?: string;
  alreadyRevoked: boolean;
}

export type ServerTokenRevokeEvent =
  | { kind: "revoking"; name: string }
  | { kind: "completed"; data: ServerTokenRevokeData }
  | { kind: "error"; error: SwampError };

export interface ServerTokenRevokeInput {
  name: string;
}

export interface ServerTokenRevokeDeps {
  runRevoke: (name: string) => AsyncIterable<ModelMethodRunEvent>;
}

export async function createServerTokenRevokeDeps(
  ctx: LibSwampContext,
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<ServerTokenRevokeDeps> {
  const runDeps = await createServerTokenRunDeps(repoDir, repoContext);
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

export async function* serverTokenRevoke(
  _ctx: LibSwampContext,
  deps: ServerTokenRevokeDeps,
  input: ServerTokenRevokeInput,
): AsyncGenerator<ServerTokenRevokeEvent> {
  yield* withGeneratorSpan(
    "swamp.access.token.revoke",
    { "token.name": input.name },
    (async function* () {
      yield { kind: "revoking" as const, name: input.name };

      let tokenRecord: Record<string, unknown> | undefined;
      let completed = false;
      for await (const event of deps.runRevoke(input.name)) {
        if (event.kind === "error") {
          const error = event.error.code === "model_not_found"
            ? {
              code: event.error.code,
              message: `Server token '${input.name}' not found. ` +
                "Use 'swamp access token list' to see existing tokens.",
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
