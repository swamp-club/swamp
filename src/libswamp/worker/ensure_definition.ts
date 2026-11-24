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

import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../../domain/models/worker/worker_model.ts";
import { runInRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { resolveOrCreateDefinition } from "../models/direct_execution.ts";
import { createWorkerModelRunDeps } from "./run_deps.ts";

/**
 * the definition the worker enroll method run would create, made ahead of it
 * through the same locked path, so that run finds it by its name file
 */
export async function ensureWorkerDefinition(
  repoDir: string,
  repoContext: RepositoryContext,
  workerName: string,
): Promise<void> {
  const deps = await createWorkerModelRunDeps(repoDir, repoContext, {
    definitionType: WORKER_MODEL_TYPE,
  });
  const modelDef = await deps.getModelDef(WORKER_MODEL_TYPE);
  const saveDefinition = deps.createAndSaveDefinition;
  const getDefinitionPath = deps.getDefinitionPath;
  if (
    modelDef === undefined || saveDefinition === undefined ||
    getDefinitionPath === undefined
  ) {
    throw new Error("The worker model is not available to create a definition");
  }
  // no push of its own, matching the enroll run's unit; v3 refuses a save outside one
  const result = await runInRootUnitOfWork(
    repoContext,
    { flush: undefined },
    () =>
      resolveOrCreateDefinition(
        {
          lookupDefinition: deps.lookupDefinition,
          getModelDef: deps.getModelDef,
          saveDefinition,
          getDefinitionPath,
        },
        WORKER_MODEL_TYPE.normalized,
        workerDefinitionName(workerName),
        "enroll",
        {},
        WORKER_MODEL_TYPE,
        modelDef,
        undefined,
        deps.autoDefinitionsDir,
      ),
  );
  if (!result.ok) throw new Error(result.error.message);
}
