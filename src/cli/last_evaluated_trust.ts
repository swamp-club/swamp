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

import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { ServerCredentialRepository } from "../domain/auth/server_credential.ts";
import { UserError } from "../domain/errors.ts";
import type { EvaluatedDefinitionCache } from "../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import {
  EVALUATION_OTHER_WRITER,
  type EvaluationTrust,
  v3EvaluationTrust,
} from "../infrastructure/datastore_v3/trusted_evaluations.ts";
import { v3DatastoreFor } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import { tokenFileBoundTo } from "./remote_run.ts";
import { resolveDatastoreForRepo, v3LocationOf } from "./repo_context.ts";

type EvaluationRepos = Parameters<typeof v3EvaluationTrust>[1];

/** What {@link checkLastEvaluation} reaches out to; tests replace it. */
export interface LastEvaluatedDeps {
  /** The checkout's serve upstream address, undefined when it has none. */
  upstream(repoDir: string): Promise<string | undefined>;
  /** This member's principal at `serverUrl`, undefined or "" when unknown. */
  principal(serverUrl: string): Promise<string | undefined>;
  /** The trust of this checkout, for a member it knows or "" for none. */
  trust(
    repoDir: string,
    repos: EvaluationRepos,
    ownPrincipal: string,
  ): Promise<EvaluationTrust>;
}

/**
 * The member this checkout writes as, undefined when it cannot be told. A bound
 * token file wins over a stored login when the checkout picks its token, as
 * `resolveServeUpstream` does, and names no member: the login may be someone else.
 */
export async function memberOfUpstream(
  serverUrl: string,
  credentials: Pick<ServerCredentialRepository, "get">,
): Promise<string | undefined> {
  const tokenFile = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  if (
    tokenFile && tokenFileBoundTo(serverUrl, [
      Deno.env.get("SWAMP_SERVE_URL"),
      Deno.env.get("SWAMP_SERVER_URL"),
    ])
  ) return undefined;
  return (await credentials.get(serverUrl))?.principalId;
}

const realDeps: LastEvaluatedDeps = {
  upstream: async (repoDir) =>
    (await resolveDatastoreForRepo(repoDir)).serveUpstream?.serverUrl,
  principal: (serverUrl) =>
    memberOfUpstream(serverUrl, new FileServerCredentialRepository()),
  trust: async (repoDir, repos, ownPrincipal) =>
    v3EvaluationTrust(
      v3DatastoreFor(
        repoDir,
        await v3LocationOf(await resolveDatastoreForRepo(repoDir)),
      ),
      repos,
      ownPrincipal,
    ),
};

/** The advice for an evaluation set aside, by why it was. */
function adviceFor(error: UserError, knowsMember: boolean): string {
  return knowsMember
    ? `${error.message} Evaluate it from this checkout to replay your own.`
    : `${error.message} This checkout cannot tell which writes are yours, as with a token from the environment, so only serve's own evaluations replay.`;
}

/** The code of a refusal to replay: the caller asked for an exact replay. */
const EVALUATION_NOT_CHECKED = "evaluation_not_checked";

/**
 * vetted holds what the check read: the run replays those bytes, never a later
 * read, so what it runs is what was checked. A null cache means there is none
 */
export type LastEvaluationCheck<T> =
  | { readonly stands: true; readonly vetted: false }
  | { readonly stands: true; readonly vetted: true; readonly cache: T | null }
  | { readonly stands: false };

/**
 * Checks the last evaluation a run would replay. `read` loads it through the
 * trust it is given, and answers undefined when no workflow or behavior has the
 * name, which the run then reports as it does any unknown name. A checkout not written through serve stands without
 * reading. An evaluation another member wrote does not stand, and says so in both
 * output modes. Any other failure refuses: the caller asked for an exact replay,
 * and a fresh evaluation could run different inputs.
 *
 * @throws UserError when it cannot tell who wrote the evaluation
 */
export async function checkLastEvaluation<T>(
  repoDir: string,
  repos: EvaluationRepos,
  outputMode: "log" | "json",
  read: (trust: EvaluationTrust) => Promise<T | null | undefined>,
  deps: LastEvaluatedDeps = realDeps,
): Promise<LastEvaluationCheck<T>> {
  const upstream = await deps.upstream(repoDir);
  if (upstream === undefined) return { stands: true, vetted: false };
  let knowsMember = false;
  try {
    const principal = await deps.principal(upstream) ?? "";
    knowsMember = principal !== "";
    // Unknown is not unset: "" matches only serve's own records and takes
    // the checkout's strict path.
    const cache = await read(await deps.trust(repoDir, repos, principal));
    if (cache === undefined) return { stands: true, vetted: false };
    return { stands: true, vetted: true, cache };
  } catch (error) {
    if (error instanceof UserError && error.code === EVALUATION_NOT_CHECKED) {
      throw error;
    }
    if (error instanceof UserError && error.code === "evaluation_not_trusted") {
      // Its message says why, and what to do.
      throw new UserError(
        `Not replayed: ${error.message}`,
        EVALUATION_NOT_CHECKED,
      );
    }
    if (
      !(error instanceof UserError && error.code === EVALUATION_OTHER_WRITER)
    ) {
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/\.$/, "");
      throw new UserError(
        `The last evaluation could not be read, so it was not replayed: ${reason}. Run again, or run without --last-evaluated.`,
        EVALUATION_NOT_CHECKED,
      );
    }
    const advice = adviceFor(error, knowsMember);
    if (outputMode === "json") {
      console.error(JSON.stringify({
        event: "last_evaluated_set_aside",
        inputsReplayed: false,
        reason:
          `${advice} Stored inputs are not replayed; pass them with --input.`,
      }));
    } else {
      getSwampLogger(["cli", "last-evaluated"]).warn(
        "Evaluating again instead of replaying the last evaluation; its stored inputs are not replayed, so pass them with --input. {advice}",
        { advice },
      );
    }
    return { stands: false };
  }
}

/**
 * Reads a behavior's last evaluation through `trust`. With a type, as `@type
 * method name` names one, the name need not have a behavior yet: the run creates
 * it, so an evaluation found by name alone would replay unchecked. None of that
 * type and name reads as no evaluation. Without a type, undefined is an unknown
 * name, which the run reports.
 */
export async function lastEvaluatedDefinition(
  trust: EvaluationTrust,
  definitionRepo: Parameters<typeof findDefinitionByIdOrName>[0],
  modelIdOrName: string,
  direct: { typeArg?: string; definitionName?: string },
): Promise<EvaluatedDefinitionCache | null | undefined> {
  if (direct.typeArg !== undefined && direct.definitionName !== undefined) {
    const named = await trust.definition(
      ModelType.create(direct.typeArg),
      direct.definitionName,
    );
    // The @ marks direct execution; repo-local types register without it.
    return named ?? (direct.typeArg.startsWith("@")
      ? await trust.definition(
        ModelType.create(direct.typeArg.slice(1)),
        direct.definitionName,
      )
      : null);
  }
  const found = await findDefinitionByIdOrName(definitionRepo, modelIdOrName);
  return found === null
    ? undefined
    : await trust.definition(found.type, found.definition.name);
}
