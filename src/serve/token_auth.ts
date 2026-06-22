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

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext, modelMethodRun } from "../libswamp/mod.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../domain/models/access/server_token_model.ts";
import { createModelMethodRunDeps } from "./deps.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "token-auth"]);

const TOKEN_DATA_NAME = "token-main";

/**
 * Splits a presented server token of the form `<name>.<secret>`.
 * The name half addresses the token aggregate; the secret half is compared
 * against the vault-stored plaintext.
 */
export function splitServerToken(
  presented: string,
): { name: string; secret: string } | null {
  const dot = presented.indexOf(".");
  if (dot <= 0 || dot === presented.length - 1) {
    return null;
  }
  return { name: presented.slice(0, dot), secret: presented.slice(dot + 1) };
}

export type ServerTokenAuthResult =
  | { ok: true; principalId: string }
  | { ok: false; error: string };

/**
 * Validates a presented `<name>.<secret>` server token by running the
 * ServerToken model's `redeem` method. Returns the authenticated
 * principal ID on success, or an error message on failure.
 */
const MAX_TOKEN_LENGTH = 512;

export async function authenticateServerToken(
  presented: string,
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<ServerTokenAuthResult> {
  if (presented.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: "Token exceeds maximum length" };
  }

  const split = splitServerToken(presented);
  if (split === null) {
    return {
      ok: false,
      error: "Invalid token format: expected <name>.<secret>",
    };
  }

  const deps = await createModelMethodRunDeps(repoDir, repoContext, {
    directExecution: true,
  });
  const libCtx = createLibSwampContext({});

  let principalId: string | undefined;
  for await (
    const event of modelMethodRun(libCtx, deps, {
      modelIdOrName: split.name,
      methodName: "redeem",
      inputs: { presentedToken: presented },
      lastEvaluated: false,
      typeArg: SERVER_TOKEN_MODEL_TYPE.normalized,
      definitionName: split.name,
      skipAllReports: true,
    })
  ) {
    if (event.kind === "error") {
      logger.debug("Token authentication failed for {name}: {error}", {
        name: split.name,
        error: event.error.message,
      });
      return { ok: false, error: "Authentication failed" };
    }
    if (event.kind === "completed") {
      const tokenRecord = event.run.dataArtifacts.find(
        (artifact) => artifact.name === TOKEN_DATA_NAME,
      )?.attributes;
      if (tokenRecord && typeof tokenRecord.principalId === "string") {
        principalId = tokenRecord.principalId;
      }
    }
  }

  if (principalId === undefined) {
    return {
      ok: false,
      error: "Token validation completed but principal could not be resolved",
    };
  }

  logger.info("Authenticated token {name} as {principal}", {
    name: split.name,
    principal: principalId,
  });
  return { ok: true, principalId };
}
