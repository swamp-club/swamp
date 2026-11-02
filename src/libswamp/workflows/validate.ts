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

import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowValidationResult } from "../../domain/workflows/validation_service.ts";
import {
  DefaultWorkflowValidationService,
  type MethodResolution,
  type ModelMethodResolver,
  type SensitiveOutputVaultResolver,
} from "../../domain/workflows/validation_service.ts";
import {
  sensitiveOutputTargetVaults,
  type SensitiveOutputVaultConfig,
} from "../../domain/models/sensitive_output_vault.ts";
import { inferMethodKind, isMutatingKind } from "../../domain/models/model.ts";
import { mergeDataOutputOverrides } from "../../domain/workflows/execution_service.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError } from "../errors.ts";
import { WorkflowSchemaError } from "../../domain/workflows/workflow_schema_error.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { DefaultModelValidationService } from "../../domain/models/validation_service.ts";
import {
  outputSpecTags,
  reservedRunTagRefusal,
} from "../../domain/models/data_writer.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { requiredArgumentNames } from "../../domain/models/required_arguments.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type BrokenWorkflow,
  findMisnamedWorkflow,
  listBrokenWorkflows,
  type MisnamedWorkflow,
} from "./broken_workflow.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";

import { diagnoseSecretMisuse } from "../../infrastructure/cel/secret_diagnostics.ts";

export { isUuid };

export interface ValidationItemData {
  name: string;
  passed: boolean;
  warning?: boolean;
  error?: string;
  code?: string;
  location?: string;
}

export interface WorkflowValidateData {
  workflowId: string;
  workflowName: string;
  validations: ValidationItemData[];
  totalWarnings: number;
  passed: boolean;
}

export interface WorkflowValidateAllData {
  workflows: WorkflowValidateData[];
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
  passed: boolean;
}

export type WorkflowValidateEvent =
  | { kind: "resolving" }
  | {
    kind: "completed";
    data: WorkflowValidateData | WorkflowValidateAllData;
  }
  | { kind: "error"; error: SwampError };

export interface WorkflowValidateInput {
  workflowIdOrName?: string;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved,
   * and look it up by id only, so validate acts on the workflow the caller
   * authorized. A broken workflow file is then matched by its id only.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a workflow with this name and the id is accepted.
   */
  expectedName?: string;
  /**
   * Without a workflow, validates and reports only the workflows this
   * accepts. A file that fails to parse is offered by the name it declares
   * (or its path, as it is reported) with no tags, since its tags cannot be read.
   */
  include?: (workflow: WorkflowIdentity) => boolean;
}

export interface WorkflowIdentity {
  name: string;
  tags: Record<string, string>;
}

export interface WorkflowValidateDeps {
  findWorkflowById: (id: string) => Promise<Workflow | null>;
  findWorkflowByName: (name: string) => Promise<Workflow | null>;
  findAllWorkflows: () => Promise<Workflow[]>;
  validate: (workflow: Workflow) => Promise<WorkflowValidationResult[]>;
  /**
   * raw-scans workflow files that fail schema parsing, which the repository
   * lookups cannot see, so validate reports the parse error instead of not
   * found. Optional for callers without a workflows directory.
   */
  listBrokenWorkflows?: () => Promise<BrokenWorkflow[]>;
  /**
   * finds a file the repository skips for its name that declares the given name
   * or id, so a not-found error can say why. Optional like
   * `listBrokenWorkflows`.
   */
  findMisnamedWorkflow?: (idOrName: string) => Promise<MisnamedWorkflow | null>;
}

function createModelMethodResolver(
  definitionRepo: YamlDefinitionRepository,
): ModelMethodResolver {
  return {
    async resolve(modelIdOrName, methodName, modelTypeArg?) {
      if (modelTypeArg) {
        return resolveByType(modelTypeArg, methodName);
      }

      const lookupResult = await findDefinitionByIdOrName(
        definitionRepo,
        modelIdOrName,
      );
      if (!lookupResult) {
        return { status: "model_not_found" };
      }

      const { type: modelType } = lookupResult;
      const modelDef = await resolveModelType(modelType, getAutoResolver());
      if (!modelDef) {
        return { status: "type_unresolvable", modelType: modelType.normalized };
      }

      const method = modelDef.methods[methodName];
      if (!method) {
        return { status: "method_not_found", modelType: modelType.normalized };
      }

      // what the step must supply is what the method's arguments fail to parse
      // without: a transform's input keys, not the keys it produces; decided by
      // parsing, not by the JSON Schema a Zod version renders
      const requiredArgs = await requiredArgumentNames(method.arguments);

      // Runtime merges definition-supplied arguments as fallbacks under step
      // inputs; any defined key counts as present, even with unresolved
      // expressions.
      const { definition } = lookupResult;
      const methodArgValues = definition.getMethodArguments(methodName);
      const definitionProvidedArgs = Array.from(
        new Set([
          ...Object.keys(methodArgValues),
          ...Object.keys(definition.globalArguments),
        ]),
      );

      const definitionProvidedArgValues: Record<string, unknown> = {
        ...definition.globalArguments,
        ...methodArgValues,
      };

      return {
        status: "resolved",
        requiredArgs,
        definitionProvidedArgs,
        definitionProvidedArgValues,
        // The step refuses these when it runs; read from the stored file.
        literalSensitiveGlobals: new DefaultModelValidationService()
          .findLiteralSensitiveGlobals(definition, modelDef),
        // The definition's own tags are checked with the workflow's.
        reservedTagRefusal: reservedRunTagRefusal({
          modelType,
          specs: outputSpecTags(modelDef),
        })?.text,
      };
    },
  };
}

async function resolveByType(
  typeArg: string,
  methodName: string,
): Promise<MethodResolution> {
  const type = ModelType.create(typeArg);
  const modelDef = await resolveModelType(type, getAutoResolver());
  if (!modelDef) {
    return { status: "type_unresolvable", modelType: type.normalized };
  }

  const method = modelDef.methods[methodName];
  if (!method) {
    return { status: "method_not_found", modelType: type.normalized };
  }

  // what the step supplies is what each schema fails to parse without
  const methodRequired = await requiredArgumentNames(method.arguments);
  const globalRequired = modelDef.globalArguments
    ? await requiredArgumentNames(modelDef.globalArguments)
    : [];

  const requiredArgs = Array.from(
    new Set([...methodRequired, ...globalRequired]),
  );

  return {
    status: "resolved",
    requiredArgs,
    reservedTagRefusal: reservedRunTagRefusal({
      modelType: type,
      specs: outputSpecTags(modelDef),
    })?.text,
  };
}

function createSensitiveOutputVaultResolver(
  definitionRepo: YamlDefinitionRepository,
  loadVaultConfig: () => Promise<SensitiveOutputVaultConfig>,
): SensitiveOutputVaultResolver {
  let vaultConfig: Promise<SensitiveOutputVaultConfig> | undefined;
  return {
    async targetVaults({ modelIdOrName, methodName, modelType, ...step }) {
      let type: ModelType;
      let definitionResources;
      if (modelType) {
        type = ModelType.create(modelType);
      } else {
        const lookup = await findDefinitionByIdOrName(
          definitionRepo,
          modelIdOrName,
        );
        if (!lookup) return undefined;
        type = lookup.type;
        definitionResources = lookup.definition.resources;
      }
      const modelDef = await resolveModelType(type, getAutoResolver());
      const method = modelDef?.methods[methodName];
      if (!modelDef || !method) return undefined;
      if (!isMutatingKind(inferMethodKind(methodName, method))) {
        return undefined;
      }
      vaultConfig ??= loadVaultConfig();
      return sensitiveOutputTargetVaults(
        modelDef.resources,
        // As the step executor passes them: a step override merges over the
        // definition's for its spec, field by field.
        mergeDataOutputOverrides(
          definitionResources,
          [...step.dataOutputOverrides],
        ),
        await vaultConfig,
      );
    },
  };
}

export function createWorkflowValidateDeps(
  workflowRepo: WorkflowRepository,
  definitionRepo?: YamlDefinitionRepository,
  workflowsDir?: string,
  loadVaultConfig?: () => Promise<SensitiveOutputVaultConfig>,
): WorkflowValidateDeps {
  const methodResolver = definitionRepo
    ? createModelMethodResolver(definitionRepo)
    : undefined;
  const validationService = new DefaultWorkflowValidationService(
    methodResolver,
    definitionRepo ? workflowRepo : undefined,
    definitionRepo && loadVaultConfig
      ? createSensitiveOutputVaultResolver(definitionRepo, loadVaultConfig)
      : undefined,
    definitionRepo
      ? async (idOrName) => {
        const found = await findDefinitionByIdOrName(definitionRepo, idOrName);
        return found && {
          name: found.definition.name,
          tags: found.definition.tags,
        };
      }
      : undefined,
    (expression, location, workflow, embedded) =>
      diagnoseSecretMisuse(
        expression,
        `${workflowRepo.getPath(workflow.id)} ${location}`,
        embedded,
      ),
  );
  return {
    findWorkflowById: (id) => workflowRepo.findById(createWorkflowId(id)),
    findWorkflowByName: (name) => workflowRepo.findByName(name),
    findAllWorkflows: () => workflowRepo.findAll(),
    validate: (workflow) => validationService.validate(workflow),
    ...(workflowsDir
      ? {
        listBrokenWorkflows: () => listBrokenWorkflows(workflowsDir),
        findMisnamedWorkflow: (idOrName: string) =>
          findMisnamedWorkflow(workflowsDir, idOrName),
      }
      : {}),
  };
}

function toBrokenValidateData(broken: BrokenWorkflow): WorkflowValidateData {
  return {
    workflowId: broken.id ?? "",
    workflowName: broken.name ?? broken.file,
    validations: [
      {
        name: "Schema validation",
        passed: false,
        error: `${broken.error} (file: ${broken.file})`,
      },
    ],
    totalWarnings: 0,
    passed: false,
  };
}

function toValidationItemData(
  results: WorkflowValidationResult[],
): ValidationItemData[] {
  return results.map((r) => ({
    name: r.name,
    passed: r.passed,
    ...(r.warning ? { warning: true } : {}),
    error: r.error,
    ...(r.code === undefined ? {} : { code: r.code, location: r.location }),
  }));
}

export function isWorkflowValidateAllData(
  data: WorkflowValidateData | WorkflowValidateAllData,
): data is WorkflowValidateAllData {
  return "workflows" in data;
}

async function* validateAll(
  deps: WorkflowValidateDeps,
  include: (workflow: WorkflowIdentity) => boolean = () => true,
): AsyncIterable<WorkflowValidateEvent> {
  const allWorkflows = (await deps.findAllWorkflows()).filter((workflow) =>
    include({ name: workflow.name, tags: workflow.tags ?? {} })
  );

  // Files the repository skipped because they fail schema parsing must
  // count as failures — otherwise a broken file makes validate-all report
  // all-green while the workflow silently no longer loads.
  const brokenWorkflows =
    (deps.listBrokenWorkflows ? await deps.listBrokenWorkflows() : []).filter((
      broken,
    ) => include({ name: broken.name ?? broken.file, tags: {} }));

  if (allWorkflows.length === 0 && brokenWorkflows.length === 0) {
    yield {
      kind: "completed",
      data: {
        workflows: [],
        totalPassed: 0,
        totalFailed: 0,
        totalWarnings: 0,
        passed: true,
      },
    };
    return;
  }

  const results: WorkflowValidateData[] = [];
  for (const broken of brokenWorkflows) {
    results.push(toBrokenValidateData(broken));
  }
  for (const workflow of allWorkflows) {
    const validationResults = await deps.validate(workflow);
    const validations = toValidationItemData(validationResults);
    const allPassed = validationResults.every((r) => r.passed);
    const warningCount = validationResults.filter((r) => r.warning).length;

    results.push({
      workflowId: workflow.id,
      workflowName: workflow.name,
      validations,
      totalWarnings: warningCount,
      passed: allPassed,
    });
  }

  const totalPassed = results.filter((w) => w.passed).length;
  const totalFailed = results.length - totalPassed;
  const totalWarnings = results.reduce((sum, w) => sum + w.totalWarnings, 0);

  yield {
    kind: "completed",
    data: {
      workflows: results,
      totalPassed,
      totalFailed,
      totalWarnings,
      passed: totalFailed === 0,
    },
  };
}

async function* validateSingle(
  deps: WorkflowValidateDeps,
  workflowIdOrName: string,
  byId: boolean,
  expectedName?: string,
): AsyncIterable<WorkflowValidateEvent> {
  const lookupRepo = {
    findByName: deps.findWorkflowByName,
    findById: (id: string) => deps.findWorkflowById(id),
  };
  let workflow: Workflow | null;
  let schemaError: WorkflowSchemaError | undefined;
  try {
    workflow = byId
      ? await findWorkflowById(lookupRepo, workflowIdOrName, expectedName)
      : await findWorkflowByIdOrName(lookupRepo, workflowIdOrName);
  } catch (error) {
    // a file named after the workflow is read by the lookup itself, so its
    // schema failure is thrown rather than hidden; report it as the failed
    // schema check a file the lookup cannot see gets
    if (!(error instanceof WorkflowSchemaError)) throw error;
    workflow = null;
    schemaError = error;
  }

  if (!workflow) {
    // The file may exist but fail schema parsing, making it invisible to
    // the repository. Surface the parse error as a failed schema check
    // instead of a misleading "not found".
    const matches = (file: { id: string | null; name: string | null }) =>
      byId
        ? file.id === workflowIdOrName &&
          (expectedName === undefined || file.name === expectedName)
        : file.id === workflowIdOrName || file.name === workflowIdOrName;
    if (deps.listBrokenWorkflows) {
      const broken = (await deps.listBrokenWorkflows()).find(matches);
      if (broken) {
        yield { kind: "completed", data: toBrokenValidateData(broken) };
        return;
      }
    }
    if (schemaError) throw schemaError;
    // A file declaring it under a name the loader skips explains the miss.
    const misnamed = deps.findMisnamedWorkflow
      ? await deps.findMisnamedWorkflow(workflowIdOrName)
      : null;
    const error = notFound("Workflow", workflowIdOrName);
    yield {
      kind: "error",
      error: misnamed && matches(misnamed)
        ? { ...error, message: `${error.message}\n${misnamed.message}` }
        : error,
    };
    return;
  }

  const results = await deps.validate(workflow);
  const validations = toValidationItemData(results);
  const allPassed = results.every((r) => r.passed);
  const warningCount = results.filter((r) => r.warning).length;

  yield {
    kind: "completed",
    data: {
      workflowId: workflow.id,
      workflowName: workflow.name,
      validations,
      totalWarnings: warningCount,
      passed: allPassed,
    },
  };
}

export async function* workflowValidate(
  _ctx: LibSwampContext,
  deps: WorkflowValidateDeps,
  input: WorkflowValidateInput,
): AsyncIterable<WorkflowValidateEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.validate",
    {},
    (async function* () {
      yield { kind: "resolving" };

      if (!input.workflowIdOrName) {
        yield* validateAll(deps, input.include);
      } else {
        yield* validateSingle(
          deps,
          input.workflowIdOrName,
          input.byId ?? false,
          input.expectedName,
        );
      }
    })(),
  );
}
