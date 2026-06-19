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
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { modelMethodRun, type ModelMethodRunEvent } from "../models/run.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { createServerTokenRunDeps } from "./run_deps.ts";

export interface ServerTokenRotateData {
  name: string;
  token: string;
  principalId: string;
  expiresAt: string;
  vaultRef: { vaultName: string; secretKey: string };
}

export type ServerTokenRotateEvent =
  | { kind: "rotating"; name: string }
  | { kind: "completed"; data: ServerTokenRotateData }
  | { kind: "error"; error: SwampError };

export interface ServerTokenRotateInput {
  name: string;
  durationMs?: number;
}

export interface ServerTokenRotateDeps {
  runRotate: (
    input: { name: string; durationMs?: number },
  ) => AsyncIterable<ModelMethodRunEvent>;
  readSecret: (vaultName: string, secretKey: string) => Promise<string>;
}

export async function createServerTokenRotateDeps(
  ctx: LibSwampContext,
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<ServerTokenRotateDeps> {
  const runDeps = await createServerTokenRunDeps(repoDir, repoContext);
  const vaultService = await VaultService.fromRepository(repoDir);
  return {
    runRotate: (input) =>
      modelMethodRun(ctx, runDeps, {
        modelIdOrName: input.name,
        methodName: "rotate",
        inputs: input.durationMs !== undefined
          ? { durationMs: input.durationMs }
          : {},
        lastEvaluated: false,
      }),
    readSecret: (vaultName, secretKey) =>
      vaultService.get(vaultName, secretKey),
  };
}

const TOKEN_DATA_NAME = "token-main";

export async function* serverTokenRotate(
  _ctx: LibSwampContext,
  deps: ServerTokenRotateDeps,
  input: ServerTokenRotateInput,
): AsyncGenerator<ServerTokenRotateEvent> {
  yield* withGeneratorSpan(
    "swamp.access.token.rotate",
    { "token.name": input.name },
    (async function* () {
      yield { kind: "rotating" as const, name: input.name };

      let tokenRecord: Record<string, unknown> | undefined;
      for await (
        const event of deps.runRotate({
          name: input.name,
          durationMs: input.durationMs,
        })
      ) {
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
          tokenRecord = event.run.dataArtifacts.find(
            (artifact) => artifact.name === TOKEN_DATA_NAME,
          )?.attributes;
        }
      }

      if (
        tokenRecord === undefined ||
        typeof tokenRecord.expiresAt !== "string" ||
        typeof tokenRecord.secretKey !== "string" ||
        typeof tokenRecord.vaultName !== "string"
      ) {
        yield {
          kind: "error" as const,
          error: {
            code: "token_record_missing",
            message: `Rotate completed but the '${TOKEN_DATA_NAME}' record ` +
              `for token '${input.name}' was not produced`,
          },
        };
        return;
      }

      const plaintext = await deps.readSecret(
        tokenRecord.vaultName,
        tokenRecord.secretKey,
      );

      yield {
        kind: "completed" as const,
        data: {
          name: input.name,
          token: `${input.name}.${plaintext}`,
          principalId: typeof tokenRecord.principalId === "string"
            ? tokenRecord.principalId
            : "",
          expiresAt: tokenRecord.expiresAt,
          vaultRef: {
            vaultName: tokenRecord.vaultName,
            secretKey: tokenRecord.secretKey,
          },
        },
      };
    })(),
  );
}
