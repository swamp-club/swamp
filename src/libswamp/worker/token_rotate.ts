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
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { modelMethodRun, type ModelMethodRunEvent } from "../models/run.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  EnrollmentTokenSchema,
} from "../../domain/models/worker/enrollment_token_model.ts";
import { createWorkerModelRunDeps } from "./run_deps.ts";

export interface WorkerTokenRotateData {
  name: string;
  /** the successor credential `<name>.<secret>` — shown once */
  token: string;
  expiresAt: string;
  /** until then the old credential still enrolls, for hosts not yet rotated */
  predecessorExpiresAt: string | null;
  /** false for a local rotation, which reaches no connected worker */
  delivered: boolean;
  rotated: { worker: string; persisted: boolean }[];
  notRotated: { worker: string; reason: string }[];
  /** null for a local rotation, which cannot see which machines are connected */
  unconnectedBindings: number | null;
  /** unconnected machines whose secret this rotation retired; null when local */
  retiredBindings: number | null;
}

export type WorkerTokenRotateEvent =
  | { kind: "rotating"; name: string }
  | { kind: "completed"; data: WorkerTokenRotateData }
  | { kind: "error"; error: SwampError };

export interface WorkerTokenRotateInput {
  name: string;
  durationMs?: number;
}

export interface WorkerTokenRotateDeps {
  /** by type as well as name, so another behavior with the name is never rotated */
  findTokenDefinition: (
    name: string,
  ) => Promise<{ id: string; name: string } | null>;
  runRotate: (
    token: { id: string; name: string },
    durationMs?: number,
  ) => AsyncIterable<ModelMethodRunEvent>;
  readSecret: (vaultName: string, secretKey: string) => Promise<string>;
}

export async function createWorkerTokenRotateDeps(
  ctx: LibSwampContext,
  repoDir: string,
  repoContext: RepositoryContext,
  options?: { vaultsDir?: string },
): Promise<WorkerTokenRotateDeps> {
  const runDeps = await createWorkerModelRunDeps(repoDir, repoContext, {
    vaultsDir: options?.vaultsDir,
    definitionType: ENROLLMENT_TOKEN_MODEL_TYPE,
  });
  const vaultService = await VaultService.fromRepository(repoDir, {
    vaultsDir: options?.vaultsDir,
  });
  return {
    findTokenDefinition: async (name) => {
      const definition = await repoContext.definitionRepo.findByName(
        ENROLLMENT_TOKEN_MODEL_TYPE,
        name,
      );
      return definition ? { id: definition.id, name: definition.name } : null;
    },
    // by name through the typed lookup, refused if it no longer resolves to
    // the definition found above; a bare id would be matched as a name first
    runRotate: (token, durationMs) =>
      modelMethodRun(ctx, runDeps, {
        modelIdOrName: token.name,
        lockedDefinitionId: token.id,
        methodName: "rotate",
        inputs: durationMs !== undefined ? { durationMs } : {},
        lastEvaluated: false,
      }),
    readSecret: (vaultName, secretKey) =>
      vaultService.get(vaultName, secretKey, "worker:token-rotate"),
  };
}

const TOKEN_DATA_NAME = "token-main";

export async function* workerTokenRotate(
  ctx: LibSwampContext,
  deps: WorkerTokenRotateDeps,
  input: WorkerTokenRotateInput,
): AsyncGenerator<WorkerTokenRotateEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.worker.token.rotate",
      { "token.name": input.name },
      (async function* () {
        yield { kind: "rotating" as const, name: input.name };

        const definition = await deps.findTokenDefinition(input.name);
        if (definition === null) {
          yield {
            kind: "error" as const,
            error: {
              code: "model_not_found",
              message: `Enrollment token '${input.name}' not found. ` +
                "Use 'swamp worker token list' to see existing tokens.",
            },
          };
          return;
        }

        let tokenRecord: Record<string, unknown> | undefined;
        for await (
          const event of deps.runRotate(definition, input.durationMs)
        ) {
          if (event.kind === "error") {
            yield { kind: "error" as const, error: event.error };
            return;
          }
          if (event.kind === "completed") {
            tokenRecord = event.run.dataArtifacts.find(
              (artifact) => artifact.name === TOKEN_DATA_NAME,
            )?.attributes;
          }
        }

        const parsed = EnrollmentTokenSchema.safeParse(tokenRecord);
        if (!parsed.success) {
          yield {
            kind: "error" as const,
            error: {
              code: "token_record_missing",
              message: `Rotation completed but the '${TOKEN_DATA_NAME}' ` +
                `record for token '${input.name}' was not produced`,
            },
          };
          return;
        }
        const token = parsed.data;
        let secret: string;
        try {
          secret = await deps.readSecret(token.vaultName, token.secretKey);
        } catch {
          // no vault detail: serve shows this message, and a path in it would
          // make its sanitizer drop the reveal hint
          yield {
            kind: "error" as const,
            error: {
              code: "vault_read_failed",
              message:
                `Enrollment token '${input.name}' was rotated, but its new secret could not be read; read it with: swamp worker token reveal ${input.name}`,
            },
          };
          return;
        }

        yield {
          kind: "completed" as const,
          data: {
            name: input.name,
            token: `${input.name}.${secret}`,
            expiresAt: token.expiresAt,
            predecessorExpiresAt: token.predecessor?.expiresAt ?? null,
            delivered: false,
            rotated: [],
            notRotated: [],
            unconnectedBindings: null,
            retiredBindings: null,
          },
        };
      })(),
    ));
}
