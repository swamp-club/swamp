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

import { runGeneratorWithoutVaultAccess } from "../../domain/vaults/run_vault_access.ts";
import { isUnreadableContentError } from "../../domain/datastore/unreadable_content.ts";
import {
  SERVE_MEMBER_DATA_NAME,
  SERVE_MEMBER_MODEL_TYPE,
} from "../../domain/models/serve/serve_member_names.ts";
import { ServeMember } from "../../domain/serve/serve_member.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import {
  repoUnitOfWorkFactory,
  runInRootUnitOfWork,
} from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { modelMethodRun } from "../../libswamp/models/run.ts";
import { createWorkerModelRunDeps } from "../../libswamp/worker/run_deps.ts";
import type { MemberMethodRunner, MemberRecords } from "./federation_hub.ts";

const logger = getSwampLogger(["serve", "federation"]);

function parseMember(content: Uint8Array): ServeMember | null {
  try {
    return ServeMember.fromJSON(JSON.parse(new TextDecoder().decode(content)));
  } catch {
    return null;
  }
}

/** member records as swamp data; one unreadable record is left out rather than failing the read */
export function repoMemberRecords(
  repoContext: RepositoryContext,
): MemberRecords {
  const read = async (modelId: string): Promise<ServeMember | null> => {
    let content: Uint8Array | null;
    try {
      content = await repoContext.unifiedDataRepo.getContent(
        SERVE_MEMBER_MODEL_TYPE,
        modelId,
        SERVE_MEMBER_DATA_NAME,
      );
    } catch (error) {
      if (!isUnreadableContentError(error)) throw error;
      logger.warn("Skipping an unreadable member record {modelId}", {
        modelId,
      });
      return null;
    }
    return content === null ? null : parseMember(content);
  };
  return {
    async list() {
      const byName = new Map<string, ServeMember>();
      const items = await repoContext.unifiedDataRepo.findAllForType(
        SERVE_MEMBER_MODEL_TYPE,
      );
      for (const { data, modelId } of items) {
        if (data.isRenamed || data.isDeleted) continue;
        if (data.name !== SERVE_MEMBER_DATA_NAME) continue;
        const member = await read(modelId);
        if (member === null) continue;
        // a definition recreated over stale data: the newest join wins
        const seen = byName.get(member.name);
        if (seen === undefined || member.joinedAt > seen.joinedAt) {
          byName.set(member.name, member);
        }
      }
      return [...byName.values()];
    },
    async get(name) {
      const definition = await repoContext.definitionRepo.findByName(
        SERVE_MEMBER_MODEL_TYPE,
        name,
      );
      return definition === null ? null : await read(definition.id);
    },
  };
}

export interface RepoMemberMethodRunnerOptions {
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  /** pushes the root unit's writes to a remote datastore */
  readonly flush?: () => Promise<void>;
}

export function repoMemberMethodRunner(
  options: RepoMemberMethodRunnerOptions,
): MemberMethodRunner {
  const { repoDir, repoContext, flush } = options;
  return async (name, call) => {
    await runInRootUnitOfWork(repoContext, { flush }, async () => {
      const deps = await createWorkerModelRunDeps(repoDir, repoContext, {
        definitionType: SERVE_MEMBER_MODEL_TYPE,
      });
      const libCtx = createLibSwampContext({
        openUnitOfWork: repoUnitOfWorkFactory(repoContext),
      });
      // inputs carry text a member chose, so expressions in them are never evaluated
      for await (
        const event of runGeneratorWithoutVaultAccess(() =>
          modelMethodRun(libCtx, deps, {
            modelIdOrName: name,
            methodName: call.method,
            inputs: call.inputs as unknown as Record<string, unknown>,
            literalInputs: true,
            lastEvaluated: false,
            typeArg: SERVE_MEMBER_MODEL_TYPE.normalized,
            definitionName: name,
            skipAllReports: true,
          })
        )
      ) {
        if (event.kind === "error") {
          const detail = event.error as unknown;
          throw new Error(
            detail instanceof Error
              ? detail.message
              : typeof detail === "object" && detail !== null &&
                  "message" in detail
              ? String((detail as { message: unknown }).message)
              : String(detail),
          );
        }
      }
    });
  };
}
