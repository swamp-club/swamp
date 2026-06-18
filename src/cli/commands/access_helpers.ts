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

import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { runFileSink } from "../../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { ModelMethodRunDeps } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import {
  parseResourceSelector,
  type ResourceSelector,
} from "../../domain/access/resource_selector.ts";

export const LOCAL_PRINCIPAL = "user:local";

export function validateServerRepoExclusivity(
  server: string | undefined,
  repoDir: string | undefined,
): void {
  if (server && repoDir) {
    throw new UserError(
      "Cannot specify both --server and --repo-dir — " +
        "--server operates on a remote server, not a local repository",
    );
  }
}

export function parseResourceFlag(value: string): ResourceSelector {
  try {
    return parseResourceSelector(value);
  } catch (error) {
    throw new UserError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

const POISONED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseFieldFlags(
  raw: string[] | undefined,
): Record<string, unknown> {
  if (!raw || raw.length === 0) return {};
  const fields: Record<string, unknown> = Object.create(null);
  for (const entry of raw) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex === -1) {
      throw new UserError(
        `Invalid --field value "${entry}": expected "key=value" (e.g. "tags.env=staging")`,
      );
    }
    const key = entry.slice(0, eqIndex);
    if (key.length === 0) {
      throw new UserError(
        `Invalid --field value "${entry}": key cannot be empty`,
      );
    }
    const value = entry.slice(eqIndex + 1);
    const parts = key.split(".");
    for (const part of parts) {
      if (part.length === 0) {
        throw new UserError(
          `Invalid --field key "${key}": empty segment in dotted path`,
        );
      }
      if (POISONED_KEYS.has(part)) {
        throw new UserError(
          `Invalid --field key "${key}": "${part}" is not allowed as a key segment`,
        );
      }
    }
    // deno-lint-ignore no-explicit-any
    let target: Record<string, any> = fields;
    for (let i = 0; i < parts.length - 1; i++) {
      if (
        !(Object.prototype.hasOwnProperty.call(target, parts[i])) ||
        typeof target[parts[i]] !== "object"
      ) {
        target[parts[i]] = Object.create(null);
      }
      target = target[parts[i]] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
  return fields;
}

export function parseActionsFlag(value: string): string[] {
  const actions = value.split(",").map((a) => a.trim()).filter((a) =>
    a.length > 0
  );
  const validActions = ["run", "read", "write", "admin"];
  for (const action of actions) {
    if (!validActions.includes(action)) {
      throw new UserError(
        `Invalid action "${action}": must be one of ${validActions.join(", ")}`,
      );
    }
  }
  if (actions.length === 0) {
    throw new UserError("At least one action is required");
  }
  return actions;
}

export function buildModelMethodRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
  isDirectExecution: boolean,
): ModelMethodRunDeps {
  return {
    repoDir,
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
    getModelDef: (type) => resolveModelType(type, getAutoResolver()),
    createEvaluationService: () => {
      const dqs = new DataQueryService(
        repoContext.catalogStore,
        repoContext.unifiedDataRepo,
      );
      return new ExpressionEvaluationService(
        repoContext.definitionRepo,
        repoDir,
        {
          dataRepo: repoContext.unifiedDataRepo,
          dataQueryService: dqs,
        },
      );
    },
    loadEvaluatedDefinition: (type, name) =>
      repoContext.evaluatedDefinitionRepo.findByName(type, name),
    saveEvaluatedDefinition: (type, definition) =>
      repoContext.evaluatedDefinitionRepo.save(type, definition),
    createExecutionService: () => new DefaultMethodExecutionService(),
    createVaultService: () => VaultService.fromRepository(repoDir),
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
    outputRepo: repoContext.outputRepo,
    dataQueryService: new DataQueryService(
      repoContext.catalogStore,
      repoContext.unifiedDataRepo,
    ),
    createRunLog: async (modelType, method, definitionId) => {
      const redactor = new SecretRedactor();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFilePath = join(
        swampPath(repoDir, SWAMP_SUBDIRS.outputs),
        modelType.normalized,
        method,
        `${definitionId}-${timestamp}.log`,
      );
      const logCategory: string[] = [];
      await runFileSink.register(
        logCategory,
        logFilePath,
        redactor,
        swampPath(repoDir),
      );
      return {
        logFilePath,
        redactor,
        cleanup: () => runFileSink.unregister(logCategory),
      };
    },
    createAndSaveDefinition: isDirectExecution
      ? async (type, definition) => {
        const autoDefRepo = new YamlDefinitionRepository(
          repoDir,
          undefined,
          swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
          false,
        );
        await autoDefRepo.save(type, definition);
      }
      : undefined,
    getDefinitionPath: isDirectExecution
      ? (type, id) => {
        return join(
          swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
          type.toDirectoryPath(),
          `${id}.yaml`,
        );
      }
      : undefined,
  };
}
