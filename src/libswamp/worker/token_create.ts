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
 * Mint a worker enrollment token (see design/remote-execution.md,
 * "Enrollment tokens").
 *
 * Runs the `mint` method on the built-in `swamp/enrollment-token` model via
 * the same direct type execution path as
 * `swamp model @swamp/enrollment-token method run mint <name>` —
 * auto-creating the model instance named after the token — then reads the
 * plaintext back from the vault so the CLI can show it exactly once.
 */

import type { LibSwampContext } from "../context.ts";
import { type SwampError, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { modelMethodRun, type ModelMethodRunEvent } from "../models/run.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  type MaxEnrollments,
} from "../../domain/models/worker/enrollment_token_model.ts";

export type { MaxEnrollments } from "../../domain/models/worker/enrollment_token_model.ts";
import { createWorkerModelRunDeps } from "./run_deps.ts";

/** Data payload for the completed event. */
export interface WorkerTokenCreateData {
  name: string;
  /** Token plaintext — shown once, never persisted outside the vault. */
  token: string;
  expiresAt: string;
  maxEnrollments: MaxEnrollments;
  vaultRef: { vaultName: string; secretKey: string };
}

export type WorkerTokenCreateEvent =
  | { kind: "minting"; name: string; vaultName: string }
  | { kind: "completed"; data: WorkerTokenCreateData }
  | { kind: "error"; error: SwampError };

export interface WorkerTokenCreateInput {
  name: string;
  durationMs: number;
  /** Omit to use the repo's sole configured vault. */
  vaultName?: string;
  maxEnrollments?: MaxEnrollments;
}

/** Dependencies for the worker token create operation. */
export interface WorkerTokenCreateDeps {
  listVaultNames: () => Promise<string[]>;
  runMint: (
    input: {
      name: string;
      durationMs: number;
      vaultName: string;
      maxEnrollments?: MaxEnrollments;
    },
  ) => AsyncIterable<ModelMethodRunEvent>;
  readSecret: (vaultName: string, secretKey: string) => Promise<string>;
}

/** Wires real infrastructure into WorkerTokenCreateDeps. */
export async function createWorkerTokenCreateDeps(
  ctx: LibSwampContext,
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<WorkerTokenCreateDeps> {
  const runDeps = await createWorkerModelRunDeps(repoDir, repoContext);
  const vaultService = await VaultService.fromRepository(repoDir);
  return {
    listVaultNames: () => Promise.resolve(vaultService.getVaultNames()),
    runMint: (input) =>
      modelMethodRun(ctx, runDeps, {
        modelIdOrName: input.name,
        methodName: "mint",
        inputs: {
          durationMs: input.durationMs,
          vaultName: input.vaultName,
          ...(input.maxEnrollments !== undefined
            ? { maxEnrollments: input.maxEnrollments }
            : {}),
        },
        lastEvaluated: false,
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: input.name,
      }),
    readSecret: (vaultName, secretKey) =>
      vaultService.get(vaultName, secretKey, "worker:token-create"),
  };
}

/**
 * Resolves the target vault: an explicit name is validated against the
 * configured vaults; otherwise a sole configured vault is used. Returns an
 * error message when resolution is ambiguous or impossible.
 */
async function resolveVaultName(
  deps: WorkerTokenCreateDeps,
  requested: string | undefined,
): Promise<{ ok: true; vaultName: string } | { ok: false; message: string }> {
  const available = await deps.listVaultNames();
  if (requested !== undefined) {
    if (!available.includes(requested)) {
      const hint = available.length > 0
        ? `Available vaults: ${available.join(", ")}`
        : "No vaults are configured. Create one with: swamp vault create <type> <name>";
      return {
        ok: false,
        message: `Vault '${requested}' is not configured. ${hint}`,
      };
    }
    return { ok: true, vaultName: requested };
  }
  if (available.length === 0) {
    return {
      ok: false,
      message: "No vaults are configured — the token plaintext must be " +
        "stored in a vault. Create one with: swamp vault create <type> <name>",
    };
  }
  if (available.length > 1) {
    return {
      ok: false,
      message: `Multiple vaults are configured (${
        available.join(", ")
      }). Pass --vault <name> to choose one.`,
    };
  }
  return { ok: true, vaultName: available[0] };
}

const TOKEN_DATA_NAME = "token-main";

/**
 * Mints a named enrollment token and yields the plaintext exactly once.
 */
export async function* workerTokenCreate(
  _ctx: LibSwampContext,
  deps: WorkerTokenCreateDeps,
  input: WorkerTokenCreateInput,
): AsyncGenerator<WorkerTokenCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.token.create",
    { "token.name": input.name },
    (async function* () {
      const resolved = await resolveVaultName(deps, input.vaultName);
      if (!resolved.ok) {
        yield {
          kind: "error" as const,
          error: validationFailed(resolved.message),
        };
        return;
      }
      const vaultName = resolved.vaultName;

      yield { kind: "minting" as const, name: input.name, vaultName };

      let tokenRecord: Record<string, unknown> | undefined;
      for await (
        const event of deps.runMint({
          name: input.name,
          durationMs: input.durationMs,
          vaultName,
          maxEnrollments: input.maxEnrollments,
        })
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

      if (
        tokenRecord === undefined ||
        typeof tokenRecord.expiresAt !== "string" ||
        typeof tokenRecord.secretKey !== "string"
      ) {
        yield {
          kind: "error" as const,
          error: {
            code: "token_record_missing",
            message: `Mint completed but the '${TOKEN_DATA_NAME}' record ` +
              `for token '${input.name}' was not produced`,
          },
        };
        return;
      }

      const secretKey = tokenRecord.secretKey;
      const plaintext = await deps.readSecret(vaultName, secretKey);

      yield {
        kind: "completed" as const,
        data: {
          name: input.name,
          // The presented credential is `<name>.<secret>`: the name half
          // addresses the token aggregate at enrollment, the secret half is
          // compared against the vault-stored plaintext (see
          // splitEnrollmentToken in src/serve/worker_gateway.ts).
          token: `${input.name}.${plaintext}`,
          expiresAt: tokenRecord.expiresAt,
          maxEnrollments: (tokenRecord.maxEnrollments as MaxEnrollments) ?? 1,
          vaultRef: { vaultName, secretKey },
        },
      };
    })(),
  );
}
