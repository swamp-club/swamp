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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type EvaluationTrust,
  v3EvaluationTrust,
} from "../infrastructure/datastore_v3/trusted_evaluations.ts";
import { v3DatastoreFor } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import { resolveDatastoreForRepo, v3LocationOf } from "./repo_context.ts";

/**
 * Whether a run may use its last evaluation. `read` loads it through the trust
 * it is given. Any checkout that is not written through serve answers true
 * without reading; a read that cannot vouch for the evaluation answers false.
 */
export async function lastEvaluatedStands(
  repoDir: string,
  repos: Parameters<typeof v3EvaluationTrust>[1],
  read: (trust: EvaluationTrust) => Promise<unknown>,
): Promise<boolean> {
  const resolution = await resolveDatastoreForRepo(repoDir);
  if (resolution.serveUpstream === undefined) return true;
  try {
    const credential = await new FileServerCredentialRepository().get(
      resolution.serveUpstream.serverUrl,
    );
    await read(v3EvaluationTrust(
      v3DatastoreFor(repoDir, await v3LocationOf(resolution)),
      repos,
      credential?.principalId,
    ));
    return true;
  } catch (error) {
    getSwampLogger(["cli", "last-evaluated"]).warn(
      "Evaluating again: the last evaluation is not one this checkout can vouch for ({reason})",
      { reason: error instanceof Error ? error.message : String(error) },
    );
    return false;
  }
}
