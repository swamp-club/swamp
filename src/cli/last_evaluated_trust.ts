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
 * Whether `--last-evaluated` stands in a serve-mode checkout (swamp-club#4245).
 *
 * Running an evaluation skips evaluating, and its checks. A checkout reads
 * evaluations other members forwarded, so it runs only one serve or its own
 * member wrote; any other is set aside and the run evaluates again.
 *
 * @module
 */

import { UserError } from "../domain/errors.ts";
import {
  EVALUATION_OTHER_WRITER,
  type EvaluationTrust,
  v3EvaluationTrust,
} from "../infrastructure/datastore_v3/trusted_evaluations.ts";
import { v3DatastoreFor } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import { resolveDatastoreForRepo, v3LocationOf } from "./repo_context.ts";

type EvaluationRepos = Parameters<typeof v3EvaluationTrust>[1];

/** What {@link lastEvaluatedStands} reaches out to; tests replace it. */
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

const realDeps: LastEvaluatedDeps = {
  upstream: async (repoDir) =>
    (await resolveDatastoreForRepo(repoDir)).serveUpstream?.serverUrl,
  principal: async (serverUrl) =>
    (await new FileServerCredentialRepository().get(serverUrl))?.principalId,
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
    : `${error.message} This checkout cannot tell which writes are yours: a token from the environment names no member, so only serve's own evaluations replay.`;
}

/** The code of a refusal to replay: the caller asked for an exact replay. */
const EVALUATION_NOT_CHECKED = "evaluation_not_checked";

/**
 * What a run may do with its last evaluation. `vetted` holds what the check read:
 * the run replays those bytes, never a later read of the repository, so what it
 * runs is what was checked (swamp-club#4245).
 */
export type LastEvaluationCheck<T> =
  | { readonly stands: true; readonly vetted: false }
  | { readonly stands: true; readonly vetted: true; readonly cache: T }
  | { readonly stands: false };

/**
 * Checks the last evaluation a run would replay. `read` loads it through the
 * trust it is given. A checkout not written through serve stands without
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
  read: (trust: EvaluationTrust) => Promise<T | null>,
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
    // Nothing checked means nothing to replay: never a read of the repository,
    // which could hold what this read did not.
    if (cache === null) {
      throw new UserError(
        "No previous evaluation was found to replay. Evaluate it first, or run without --last-evaluated.",
        EVALUATION_NOT_CHECKED,
      );
    }
    return { stands: true, vetted: true, cache };
  } catch (error) {
    if (error instanceof UserError && error.code === EVALUATION_NOT_CHECKED) {
      throw error;
    }
    if (error instanceof UserError && error.code === "evaluation_not_trusted") {
      // Its message says why, and what to do.
      throw new UserError(
        `The last evaluation was not replayed: ${error.message}`,
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
