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

import type { DefinitionId } from "../domain/definitions/definition.ts";
import { resolveModelType } from "../domain/extensions/extension_auto_resolver.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { DirectTypeResolver } from "../domain/workflows/execution_service.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import { resolveOrCreateDefinition } from "../libswamp/models/direct_execution.ts";
import { getAutoResolver } from "./auto_resolver_context.ts";

// workflow run and workflow resume share this so a resumed step creates its
// definition from the same arguments, globalArgs included, as a fresh run
export function createDirectTypeResolver(
  repoDir: string,
  repoContext: Pick<
    RepositoryContext,
    "definitionRepo" | "autoDefinitionsDir" | "markDirty"
  >,
): DirectTypeResolver {
  return async (
    typeArg,
    defName,
    methodName,
    inputs,
    globalArgs,
    authoredExpressions,
    sensitiveValues,
    provenance,
  ) => {
    let resolvedType = ModelType.create(typeArg);
    let modelDef = await resolveModelType(resolvedType, getAutoResolver());

    // @ is the CLI syntax marker but repo-local extensions register types
    // without it
    if (!modelDef && typeArg.startsWith("@")) {
      const strippedType = ModelType.create(typeArg.slice(1));
      const strippedDef = await resolveModelType(
        strippedType,
        getAutoResolver(),
      );
      if (strippedDef) {
        resolvedType = strippedType;
        modelDef = strippedDef;
      }
    }

    if (!modelDef) {
      throw new Error(`Unknown behavior type: ${resolvedType.normalized}`);
    }
    resolvedType = modelDef.type;
    const autoDefRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      repoContext.autoDefinitionsDir,
      false,
      repoContext.markDirty,
    );
    const result = await resolveOrCreateDefinition(
      {
        lookupDefinition: (name) =>
          findDefinitionByIdOrName(repoContext.definitionRepo, name),
        getModelDef: (type) => resolveModelType(type, getAutoResolver()),
        saveDefinition: (type, def) => autoDefRepo.save(type, def),
        getDefinitionPath: (type, id) =>
          autoDefRepo.getPath(type, id as DefinitionId),
      },
      typeArg,
      defName,
      methodName,
      inputs,
      resolvedType,
      modelDef,
      globalArgs,
      repoContext.autoDefinitionsDir,
      authoredExpressions,
      sensitiveValues,
      provenance,
    );
    if (!result.ok) throw new Error(result.error.message);
    return {
      definition: result.definition,
      modelType: result.modelType,
      created: result.created,
      routedMethodInputs: result.routedInputs.methodArguments,
      authoredExpressions: result.authoredExpressions,
    };
  };
}
