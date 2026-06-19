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
 * Mint a server token for user authentication on `swamp serve`.
 *
 * Runs the `mint` method on the built-in `swamp/server-token` model via
 * direct type execution — auto-creating the model instance named after the
 * token — then reads the plaintext back from the vault so the CLI can show
 * it exactly once.
 */

import type { LibSwampContext } from "../context.ts";
import { type SwampError, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { modelMethodRun, type ModelMethodRunEvent } from "../models/run.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../../domain/models/access/server_token_model.ts";
import { createServerTokenRunDeps } from "./run_deps.ts";

export interface ServerTokenCreateData {
  name: string;
  token: string;
  principalId: string;
  expiresAt: string;
  vaultRef: { vaultName: string; secretKey: string };
}

export type ServerTokenCreateEvent =
  | { kind: "minting"; name: string; vaultName: string }
  | { kind: "completed"; data: ServerTokenCreateData }
  | { kind: "error"; error: SwampError };

export interface ServerTokenCreateInput {
  name: string;
  principalId: string;
  principalEmail: string;
  durationMs: number;
  vaultName?: string;
}

export interface ServerTokenCreateDeps {
  listVaultNames: () => Promise<string[]>;
  runMint: (
    input: {
      name: string;
      principalId: string;
      principalEmail: string;
      durationMs: number;
      vaultName: string;
    },
  ) => AsyncIterable<ModelMethodRunEvent>;
  readSecret: (vaultName: string, secretKey: string) => Promise<string>;
}

export async function createServerTokenCreateDeps(
  ctx: LibSwampContext,
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<ServerTokenCreateDeps> {
  const runDeps = await createServerTokenRunDeps(repoDir, repoContext);
  const vaultService = await VaultService.fromRepository(repoDir);
  return {
    listVaultNames: () => Promise.resolve(vaultService.getVaultNames()),
    runMint: (input) =>
      modelMethodRun(ctx, runDeps, {
        modelIdOrName: input.name,
        methodName: "mint",
        inputs: {
          principalId: input.principalId,
          principalEmail: input.principalEmail,
          durationMs: input.durationMs,
          vaultName: input.vaultName,
        },
        lastEvaluated: false,
        typeArg: SERVER_TOKEN_MODEL_TYPE.normalized,
        definitionName: input.name,
      }),
    readSecret: (vaultName, secretKey) =>
      vaultService.get(vaultName, secretKey),
  };
}

async function resolveVaultName(
  deps: ServerTokenCreateDeps,
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

export async function* serverTokenCreate(
  _ctx: LibSwampContext,
  deps: ServerTokenCreateDeps,
  input: ServerTokenCreateInput,
): AsyncGenerator<ServerTokenCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.access.token.create",
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
          principalId: input.principalId,
          principalEmail: input.principalEmail,
          durationMs: input.durationMs,
          vaultName,
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
          token: `${input.name}.${plaintext}`,
          principalId: input.principalId,
          expiresAt: tokenRecord.expiresAt as string,
          vaultRef: { vaultName, secretKey },
        },
      };
    })(),
  );
}
