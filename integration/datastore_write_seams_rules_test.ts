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

// ratchets pin the datastore write seams so no new one appears mid-refactor;
// refactor PRs shrink these lists. Keys name file and top-level declaration,
// never a line; repeats carry " (xN)"

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { PINNED_UNSCOPED_WRITERS } from "./unscoped_write_guard.ts";
import {
  assertPinnedSet,
  constructorCalls,
  countedKeys,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

const FACTORY = "src/infrastructure/persistence/repository_factory.ts";

function isTestHelper(rel: string): boolean {
  return rel.includes("/test_helpers/") ||
    rel.startsWith("src/infrastructure/testing/");
}

interface SourceFile {
  rel: string;
  code: string;
  lines: string[];
  owners: string[];
}

async function sourceFiles(): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(path);
    if (isTestHelper(rel)) continue;
    const code = await Deno.readTextFile(path);
    const lines = code.split("\n");
    files.push({ rel, code, lines, owners: topLevelOwners(lines) });
  }
  return files;
}

const MARK_CALL =
  /\b(markDirty|notifyDirty|markDirtyHook|markDirtyBulk)\s*(?:\?\.)?\(/g;
const DEFINITION_PREFIX =
  /\b(?:async|private|public|protected|static|function|readonly|get|set)\s+(?:\*\s*)?$/;

function isDefinitionLine(line: string): boolean {
  return /\)\s*:\s*[^=]*[;{]\s*$/.test(line) ||
    /\)\s*\{\s*$/.test(line) ||
    /^\s*\w+\??\s*:/.test(line);
}

function markCallSites(files: readonly SourceFile[]): string[] {
  const keys: string[] = [];
  for (const { rel, lines, owners } of files) {
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const match of line.matchAll(MARK_CALL)) {
        const before = line.slice(0, match.index);
        if (DEFINITION_PREFIX.test(before)) continue;
        if (before.trim() === "" && isDefinitionLine(line)) continue;
        keys.push(`${rel}: ${owners[i]}`);
      }
    });
  }
  return countedKeys(keys);
}

const DATASTORE_TIER_REPOSITORIES = [
  "YamlDefinitionRepository",
  "FileSystemUnifiedDataRepository",
  "YamlWorkflowRepository",
  "YamlWorkflowRunRepository",
  "YamlOutputRepository",
  "YamlEvaluatedWorkflowRepository",
  "YamlEvaluatedDefinitionRepository",
  "YamlVaultConfigRepository",
  "JsonlAuditRepository",
  "JsonlVaultAuditRepository",
  "CompositeUnifiedDataRepository",
  "LockfileRepository",
];

const HOOK_ARGUMENT: Record<string, { index: number; file: string }> = {
  YamlDefinitionRepository: { index: 4, file: "yaml_definition_repository.ts" },
  YamlWorkflowRepository: { index: 3, file: "yaml_workflow_repository.ts" },
  YamlWorkflowRunRepository: {
    index: 3,
    file: "yaml_workflow_run_repository.ts",
  },
  FileSystemUnifiedDataRepository: {
    index: 3,
    file: "unified_data_repository.ts",
  },
  YamlOutputRepository: { index: 2, file: "yaml_output_repository.ts" },
  YamlEvaluatedDefinitionRepository: {
    index: 2,
    file: "yaml_evaluated_definition_repository.ts",
  },
  YamlEvaluatedWorkflowRepository: {
    index: 2,
    file: "yaml_evaluated_workflow_repository.ts",
  },
  YamlVaultConfigRepository: {
    index: 3,
    file: "yaml_vault_config_repository.ts",
  },
};

function repositoryConstructions(files: readonly SourceFile[]): string[] {
  const keys: string[] = [];
  for (const { rel, code, owners } of files) {
    if (rel === FACTORY) continue;
    for (const className of DATASTORE_TIER_REPOSITORIES) {
      for (const call of constructorCalls(code, className)) {
        // A class building its own instances is not a seam.
        if (owners[call.line] === className) continue;
        keys.push(`${rel}: ${owners[call.line]}: ${className}`);
      }
    }
  }
  return countedKeys(keys);
}

function unhookedWriters(files: readonly SourceFile[]): string[] {
  const keys: string[] = [];
  for (const { rel, code, owners } of files) {
    for (const [className, { index }] of Object.entries(HOOK_ARGUMENT)) {
      for (const call of constructorCalls(code, className)) {
        const hook = call.args[index];
        if (hook === undefined || hook === "undefined") {
          keys.push(`${rel}: ${owners[call.line]}: ${className}`);
        }
      }
    }
  }
  return countedKeys(keys);
}

const SCOPE_MODULE = "src/infrastructure/persistence/unit_of_work_scope.ts";
// Any reference, not only a call: an import (aliased or not) is how a scope
// would reach production code, so it counts too.
const SCOPE_REFERENCE = /\brunInUnitOfWork\b/g;

function unitOfWorkScopes(files: readonly SourceFile[]): string[] {
  const keys: string[] = [];
  for (const { rel, lines, owners } of files) {
    if (rel === SCOPE_MODULE) continue;
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const _match of line.matchAll(SCOPE_REFERENCE)) {
        keys.push(`${rel}: ${owners[i]}`);
      }
    });
  }
  return countedKeys(keys);
}

const TRANSACTION_MODULE = "src/libswamp/unit_of_work.ts";
const TRANSACTION_WRAP = /\b(?:return|yield\*)\s+withUnitOfWork\s*\(/g;
const EXPORTED_FUNCTION = /^export (?:async )?function\*?\s+(\w+)/gm;

function transactionalUseCases(files: readonly SourceFile[]): string[] {
  const keys: string[] = [];
  for (const { rel, code, lines, owners } of files) {
    if (!rel.startsWith("src/libswamp/") || rel === TRANSACTION_MODULE) {
      continue;
    }
    const exported = new Set(
      [...code.matchAll(EXPORTED_FUNCTION)].map((match) => match[1]),
    );
    lines.forEach((line, i) => {
      if (isCommentLine(line) || !exported.has(owners[i])) return;
      for (const _match of line.matchAll(TRANSACTION_WRAP)) {
        keys.push(`${rel}: ${owners[i]}`);
      }
    });
  }
  return countedKeys(keys);
}

const SEAM_MODULE = "src/infrastructure/persistence/repo_unit_of_work.ts";
const SEAM_REFERENCE = /\buseUnitOfWorkFactoryForTesting\b/g;

function unitOfWorkSeamCallers(files: readonly SourceFile[]): string[] {
  const keys: string[] = [];
  for (const { rel, lines, owners } of files) {
    if (rel === SEAM_MODULE) continue;
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const _match of line.matchAll(SEAM_REFERENCE)) {
        keys.push(`${rel}: ${owners[i]}`);
      }
    });
  }
  return countedKeys(keys);
}

const REPORTER_SEAM_MODULE =
  "src/infrastructure/persistence/unit_of_work_scope.ts";
const REPORTER_SEAM_REFERENCE =
  /\b(?:useUnscopedChangeReporterForTesting|resetUnscopedWarningsForTesting)\b/g;

function unscopedReporterSeamCallers(files: readonly SourceFile[]): string[] {
  const keys: string[] = [];
  for (const { rel, lines, owners } of files) {
    if (rel === REPORTER_SEAM_MODULE) continue;
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const _match of line.matchAll(REPORTER_SEAM_REFERENCE)) {
        keys.push(`${rel}: ${owners[i]}`);
      }
    });
  }
  return countedKeys(keys);
}

const CLI_COMMANDS_DIR = "src/cli/commands/";
const CLI_ROOT_CALL =
  /\b(?:runCommandInRootUnit|runManagedConfigMutation|runInCoordinatorRoot)\s*\(/g;
const LOCK_FLUSH_REFERENCE = /\blockResult\.flush\b/g;
const PUSH_CALL = /\.pushChanged\s*\(/g;
// matches every .checkpoint( call whatever the receiver is named, so a push
// cannot escape the pin under another name; the catalog's WAL checkpoint shares
// the name and is pinned in its own group
const CHECKPOINT_CALL = /\.checkpoint\s*\(/g;

function referenceKeys(
  files: readonly SourceFile[],
  pattern: RegExp,
  include: (rel: string) => boolean,
): string[] {
  const keys: string[] = [];
  for (const { rel, lines, owners } of files) {
    if (!include(rel)) continue;
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const _match of line.matchAll(pattern)) {
        keys.push(`${rel}: ${owners[i]}`);
      }
    });
  }
  return countedKeys(keys);
}

const inCliCommands = (rel: string) => rel.startsWith(CLI_COMMANDS_DIR);

// kind of a StagedChange literal: a literal kind or a ternary of two, keyed
// write|remove; matched alone so wrapped calls count once; any other kind
// expression goes missing from the pin
const STAGED_KIND =
  /\bkind:\s*(?:"(write|remove|bulk)"|[^,}\n?"]+\?\s*"(write|remove|bulk)"\s*:\s*"(write|remove|bulk)")/g;

function stagedChanges(files: readonly SourceFile[]): string[] {
  const repositories = new Set<string>(DATASTORE_TIER_REPOSITORIES);
  const keys: string[] = [];
  for (const { rel, lines, owners } of files) {
    lines.forEach((line, i) => {
      if (isCommentLine(line) || !repositories.has(owners[i])) return;
      for (const match of line.matchAll(STAGED_KIND)) {
        const kind = match[1] ?? `${match[2]}|${match[3]}`;
        keys.push(`${rel}: ${owners[i]} ${kind}`);
      }
    });
  }
  return countedKeys(keys);
}

const PERSISTENCE_DIR = "src/infrastructure/persistence/";

/**
 * the only persistence files that may call a mark hook, each with its reason;
 * repositories stage through signalChange, so a forwarding adapter is added
 * here on purpose
 */
const PERSISTENCE_MARK_ADAPTERS: Record<string, string> = {
  "src/infrastructure/persistence/legacy_unit_of_work.ts":
    "the legacy unit of work forwards each staged change to the mark hook",
  "src/infrastructure/persistence/unit_of_work_scope.ts":
    "signalChange calls the hook directly when no scope is bound to it",
};

function persistenceMarksOutsideAdapters(
  files: readonly SourceFile[],
): string[] {
  return markCallSites(files).filter((key) => {
    const rel = key.slice(0, key.indexOf(": "));
    return rel.startsWith(PERSISTENCE_DIR) &&
      !Object.hasOwn(PERSISTENCE_MARK_ADAPTERS, rel);
  });
}

const HOOK_FIELD = /\bthis\.(?:markDirty|markDirtyHook)\b/g;
// how far before a hook reference to look for signalChange(: the call name plus
// the newline and indentation deno fmt adds when wrapping; a longer gap reports
// a false violation, never misses one
const SIGNAL_CHANGE_LOOKBACK = 200;

/**
 * flags hook references in repository classes outside signalChange and the
 * allowed staging and lookup calls; reads across wrapped lines; scans only
 * listed classes and misses aliasing or bracket access
 */
function hookReferencesOutsideSignalChange(
  files: readonly SourceFile[],
): string[] {
  const repositories = new Set<string>(DATASTORE_TIER_REPOSITORIES);
  const keys: string[] = [];
  for (const { rel, lines, owners } of files) {
    const code = lines.map((line) => isCommentLine(line) ? "" : line);
    const source = code.join("\n");
    let offset = 0;
    code.forEach((line, i) => {
      if (repositories.has(owners[i])) {
        for (const match of line.matchAll(HOOK_FIELD)) {
          const start = offset + match.index;
          const before = source.slice(
            Math.max(0, start - SIGNAL_CHANGE_LOOKBACK),
            start,
          );
          const after = source.slice(start + match[0].length);
          if (
            /\b(?:signalChange|withChangeSignalled|stageTyped|typedStagingActive|versionFloorSource|unitAdmitsKey|storedVersionOf|forwardsToServe)\(\s*$/
              .test(
                before,
              ) &&
            /^\s*[,)]/.test(after)
          ) {
            continue;
          }
          keys.push(`${rel}: ${owners[i]}`);
        }
      }
      offset += line.length + 1;
    });
  }
  return countedKeys(keys);
}

const PINNED_MARK_CALL_SITES: readonly string[] = [
  "src/cli/commands/datastore_namespace.ts: buildMigrateDeps",
  "src/cli/commands/datastore_sync.ts: datastoreSyncCommand",
  "src/cli/commands/serve.ts: serveCommand",
  // the one-call managed-config publish the remote-failure suite exercises; no
  // command calls it, they publish through runManagedConfigMutation's root unit
  "src/cli/managed_config_sync.ts: pushManagedConfigChanges",
  "src/cli/repo_context.ts: buildMarkDirtyHook (x2)",
  "src/cli/repo_context.ts: writeCatalogExportIfNeeded",
  // the legacy unit of work forwarding staged changes to the mark hook; exactly
  // one call, later phases stage through the unit of work instead of adding
  // calls here
  "src/infrastructure/persistence/legacy_unit_of_work.ts: createLegacyUnitOfWork",
  // the one routing helper repositories stage changes through: it stages into
  // an ambient unit of work bound to the hook, or calls the hook; exactly one
  // call
  "src/infrastructure/persistence/unit_of_work_scope.ts: signalChange",
  "src/libswamp/datastores/namespace_migrate.ts: datastoreNamespaceMigrate",
  // datastoreSetupExtension: a bulk mark for .swamp/ copied into the cache
  // behind the sync service, before its push
  "src/libswamp/datastores/setup.ts: datastoreSetupExtension",
];

const PINNED_REPO_CONSTRUCTIONS: readonly string[] = [
  "src/cli/commands/access_helpers.ts: buildModelMethodRunDeps: YamlDefinitionRepository",
  "src/cli/commands/audit.ts: recordHookEntry: JsonlAuditRepository",
  "src/cli/commands/datastore_setup.ts: nudgeVaultMigration: YamlVaultConfigRepository",
  "src/cli/commands/doctor_datastores.ts: createDoctorDatastoresDeps: YamlVaultConfigRepository",
  "src/cli/commands/model_method_run.ts: createModelMethodRunCommand: YamlDefinitionRepository",
  "src/cli/commands/serve.ts: serveCommand: YamlDefinitionRepository",
  "src/cli/commands/serve.ts: serveCommand: YamlVaultConfigRepository",
  "src/cli/commands/workflow_approvals.ts: workflowApprovalsCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_cancel.ts: workflowCancelCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_approve.ts: workflowApproveCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_reject.ts: workflowRejectCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_resume.ts: workflowResumeCommand: YamlDefinitionRepository",
  "src/cli/commands/workflow_resume.ts: workflowResumeCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_run.ts: workflowRunCommand: YamlDefinitionRepository",
  "src/cli/commands/workflow_run.ts: workflowRunCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/completion_types.ts: ModelNameType: YamlDefinitionRepository",
  "src/cli/completion_types.ts: WorkflowNameType: YamlWorkflowRepository",
  "src/cli/datastore_expression_resolver.ts: createEarlyVaultService: YamlVaultConfigRepository",
  "src/cli/mod.ts: configureExtensionAutoResolver: LockfileRepository",
  "src/cli/mod.ts: configureStartupExtensions: LockfileRepository",
  "src/cli/mod.ts: initTelemetryService: YamlVaultConfigRepository",
  "src/domain/vaults/vault_service.ts: VaultService: JsonlVaultAuditRepository",
  "src/domain/vaults/vault_service.ts: VaultService: YamlVaultConfigRepository",
  "src/domain/workflows/execution_service.ts: DefaultStepExecutor: CompositeUnifiedDataRepository",
  "src/domain/workflows/execution_service.ts: DefaultStepExecutor: FileSystemUnifiedDataRepository",
  "src/domain/workflows/execution_service.ts: DefaultStepExecutor: YamlDefinitionRepository",
  "src/domain/workflows/execution_service.ts: DefaultStepExecutor: YamlEvaluatedDefinitionRepository",
  "src/domain/workflows/execution_service.ts: DefaultStepExecutor: YamlOutputRepository",
  "src/domain/workflows/execution_service.ts: WorkflowExecutionService: CompositeUnifiedDataRepository",
  "src/domain/workflows/execution_service.ts: WorkflowExecutionService: FileSystemUnifiedDataRepository",
  "src/domain/workflows/execution_service.ts: WorkflowExecutionService: YamlDefinitionRepository",
  "src/domain/workflows/execution_service.ts: WorkflowExecutionService: YamlEvaluatedDefinitionRepository",
  "src/domain/workflows/execution_service.ts: WorkflowExecutionService: YamlEvaluatedWorkflowRepository",
  "src/infrastructure/persistence/ephemeral_store.ts: wrapWithEphemeral: CompositeUnifiedDataRepository",
  "src/libswamp/access/run_deps.ts: createServerTokenRunDeps: YamlDefinitionRepository",
  "src/libswamp/audit/timeline.ts: createAuditTimelineDeps: JsonlAuditRepository",
  "src/libswamp/data/delete.ts: createDataDeleteDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/delete.ts: createDataDeleteDeps: YamlDefinitionRepository",
  "src/libswamp/data/gc.ts: createDataGcDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/gc.ts: createDataGcDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: YamlDefinitionRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: YamlWorkflowRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/list.ts: createDataListDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/list.ts: createDataListDeps: YamlDefinitionRepository",
  "src/libswamp/data/list.ts: createDataListDeps: YamlWorkflowRepository",
  "src/libswamp/data/list.ts: createDataListDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: YamlDefinitionRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: YamlWorkflowRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/rename.ts: createDataRenameDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/rename.ts: createDataRenameDeps: YamlDefinitionRepository",
  "src/libswamp/data/run_gc.ts: createRunLifecycleService: YamlEvaluatedWorkflowRepository",
  "src/libswamp/data/run_gc.ts: createRunLifecycleService: YamlOutputRepository",
  "src/libswamp/data/run_gc.ts: createRunLifecycleService: YamlWorkflowRunRepository",
  "src/libswamp/data/versions.ts: createDataVersionsDeps: FileSystemUnifiedDataRepository",
  // the retention pass prunes the repo-local agent command log (.swamp/audit),
  // never a datastore tier
  "src/libswamp/retention/collectors.ts: createRetentionCollectors: JsonlAuditRepository",
  "src/libswamp/data/versions.ts: createDataVersionsDeps: YamlDefinitionRepository",
  // doctor datastores --retention lists run snapshots, read-only
  "src/libswamp/datastores/retention_check.ts: checkSnapshots: YamlEvaluatedWorkflowRepository",
  "src/libswamp/datastores/setup.ts: createDatastoreSetupDeps: YamlVaultConfigRepository",
  "src/libswamp/extensions/list.ts: createExtensionListDeps: LockfileRepository",
  "src/libswamp/extensions/managed_lockfile_transaction.ts: ManagedLockfileTransaction: LockfileRepository",
  "src/libswamp/models/create.ts: createModelCreateDeps: YamlDefinitionRepository",
  "src/libswamp/models/delete.ts: createModelDeleteDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/delete.ts: createModelDeleteDeps: YamlDefinitionRepository",
  "src/libswamp/models/delete.ts: createModelDeleteDeps: YamlEvaluatedDefinitionRepository",
  "src/libswamp/models/delete.ts: createModelDeleteDeps: YamlOutputRepository",
  "src/libswamp/models/delete.ts: createModelDeleteDeps: YamlWorkflowRepository",
  "src/libswamp/models/delete.ts: createModelDeleteDeps: YamlWorkflowRunRepository",
  "src/libswamp/models/doctor_secrets.ts: createDoctorSecretsDeps: YamlDefinitionRepository (x2)",
  "src/libswamp/models/doctor_vaults.ts: createDoctorVaultsDeps: YamlDefinitionRepository (x2)",
  "src/libswamp/models/edit.ts: createModelEditDeps: YamlDefinitionRepository",
  "src/libswamp/models/evaluate.ts: createModelEvaluateDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/evaluate.ts: createModelEvaluateDeps: YamlDefinitionRepository",
  "src/libswamp/models/evaluate.ts: createModelEvaluateDeps: YamlEvaluatedDefinitionRepository",
  "src/libswamp/models/method_describe.ts: createModelMethodDescribeDeps: YamlDefinitionRepository",
  "src/libswamp/models/method_history_logs.ts: createModelMethodHistoryLogsDeps: YamlDefinitionRepository",
  "src/libswamp/models/method_history_logs.ts: createModelMethodHistoryLogsDeps: YamlOutputRepository",
  "src/libswamp/models/output_data.ts: createModelOutputDataDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/output_data.ts: createModelOutputDataDeps: YamlDefinitionRepository",
  "src/libswamp/models/output_data.ts: createModelOutputDataDeps: YamlOutputRepository",
  "src/libswamp/models/output_get.ts: createModelOutputGetDeps: YamlDefinitionRepository",
  "src/libswamp/models/output_get.ts: createModelOutputGetDeps: YamlOutputRepository",
  "src/libswamp/models/output_logs.ts: createModelOutputLogsDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/output_logs.ts: createModelOutputLogsDeps: YamlOutputRepository",
  "src/libswamp/models/validate.ts: createModelValidateDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/validate.ts: createModelValidateDeps: YamlDefinitionRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: YamlDefinitionRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: YamlWorkflowRepository",
  "src/libswamp/repo/init.ts: createRepoInitDeps: YamlVaultConfigRepository",
  "src/libswamp/start/start.ts: listContents: YamlDefinitionRepository",
  "src/libswamp/start/start.ts: listContents: YamlWorkflowRepository",
  "src/libswamp/vaults/annotate.ts: createVaultAnnotateDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/audit_trail.ts: createVaultAuditTrailDeps: JsonlVaultAuditRepository",
  "src/libswamp/vaults/create.ts: createVaultCreateDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/delete.ts: createVaultDeleteDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/describe.ts: createVaultDescribeDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/edit.ts: createVaultEditDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/get.ts: createVaultGetDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/inspect.ts: createVaultInspectDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/list_keys.ts: createVaultListKeysDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/migrate.ts: createVaultMigrateDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/put.ts: createVaultPutDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/read_secret.ts: createVaultReadSecretDeps: YamlVaultConfigRepository",
  "src/libswamp/worker/run_deps.ts: createWorkerModelRunDeps: YamlDefinitionRepository",
  "src/libswamp/workflows/create.ts: createWorkflowCreateDeps: YamlWorkflowRepository",
  "src/libswamp/workflows/delete.ts: createWorkflowDeleteDeps: YamlEvaluatedWorkflowRepository",
  "src/libswamp/workflows/delete.ts: createWorkflowDeleteDeps: YamlWorkflowRepository",
  "src/libswamp/workflows/delete.ts: createWorkflowDeleteDeps: YamlWorkflowRunRepository",
  "src/libswamp/workflows/evaluate.ts: createWorkflowEvaluateDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/workflows/evaluate.ts: createWorkflowEvaluateDeps: YamlDefinitionRepository",
  "src/libswamp/workflows/evaluate.ts: createWorkflowEvaluateDeps: YamlEvaluatedWorkflowRepository",
  "src/libswamp/workflows/history_get.ts: createWorkflowHistoryGetDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/workflows/history_get.ts: createWorkflowHistoryGetDeps: YamlWorkflowRepository",
  "src/libswamp/workflows/history_get.ts: createWorkflowHistoryGetDeps: YamlWorkflowRunRepository",
  "src/libswamp/workflows/history_logs.ts: createWorkflowHistoryLogsDeps: YamlWorkflowRepository",
  "src/libswamp/workflows/history_logs.ts: createWorkflowHistoryLogsDeps: YamlWorkflowRunRepository",
  "src/serve/deps.ts: createModelMethodRunDeps: YamlDefinitionRepository",
  "src/serve/deps.ts: createWorkflowRunDeps: YamlDefinitionRepository",
  "src/serve/deps.ts: createWorkflowRunDeps: YamlEvaluatedWorkflowRepository",
  "src/serve/device_auth_handler.ts: mintServerTokenImpl: YamlDefinitionRepository",
  "src/serve/handlers/access_handlers.ts: handleAccessReload: YamlDefinitionRepository",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowApprovals: YamlEvaluatedWorkflowRepository",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowApprove: YamlEvaluatedWorkflowRepository",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowReject: YamlEvaluatedWorkflowRepository",
  "src/serve/nested_run_cascade.ts: serveNestedCascade: YamlEvaluatedWorkflowRepository",
  "src/serve/suspended_run_cancel.ts: cancelSuspendedRunAndPush: YamlEvaluatedWorkflowRepository",
];

const PINNED_UNHOOKED_WRITERS: readonly string[] = [
  // read only: these repositories never write
  "src/libswamp/start/start.ts: listContents: YamlDefinitionRepository",
  "src/libswamp/start/start.ts: listContents: YamlWorkflowRepository",
  "src/cli/commands/workflow_approvals.ts: workflowApprovalsCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_cancel.ts: workflowCancelCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_approve.ts: workflowApproveCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_reject.ts: workflowRejectCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_resume.ts: workflowResumeCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_run.ts: workflowRunCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/completion_types.ts: ModelNameType: YamlDefinitionRepository",
  "src/cli/completion_types.ts: WorkflowNameType: YamlWorkflowRepository",
  "src/libswamp/data/delete.ts: createDataDeleteDeps: YamlDefinitionRepository",
  "src/libswamp/data/gc.ts: createDataGcDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: YamlDefinitionRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: YamlWorkflowRepository",
  "src/libswamp/data/get.ts: createDataGetDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/list.ts: createDataListDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/list.ts: createDataListDeps: YamlDefinitionRepository",
  "src/libswamp/data/list.ts: createDataListDeps: YamlWorkflowRepository",
  "src/libswamp/data/list.ts: createDataListDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: YamlDefinitionRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: YamlWorkflowRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/rename.ts: createDataRenameDeps: YamlDefinitionRepository",
  "src/libswamp/data/versions.ts: createDataVersionsDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/versions.ts: createDataVersionsDeps: YamlDefinitionRepository",
  "src/libswamp/models/delete.ts: createModelDeleteDeps: YamlWorkflowRepository",
  "src/libswamp/models/doctor_secrets.ts: createDoctorSecretsDeps: YamlDefinitionRepository (x2)",
  "src/libswamp/models/doctor_vaults.ts: createDoctorVaultsDeps: YamlDefinitionRepository (x2)",
  "src/libswamp/models/evaluate.ts: createModelEvaluateDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/evaluate.ts: createModelEvaluateDeps: YamlDefinitionRepository",
  "src/libswamp/models/method_describe.ts: createModelMethodDescribeDeps: YamlDefinitionRepository",
  "src/libswamp/models/method_history_logs.ts: createModelMethodHistoryLogsDeps: YamlDefinitionRepository",
  "src/libswamp/models/method_history_logs.ts: createModelMethodHistoryLogsDeps: YamlOutputRepository",
  "src/libswamp/models/output_data.ts: createModelOutputDataDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/output_data.ts: createModelOutputDataDeps: YamlDefinitionRepository",
  "src/libswamp/models/output_data.ts: createModelOutputDataDeps: YamlOutputRepository",
  "src/libswamp/models/output_get.ts: createModelOutputGetDeps: YamlDefinitionRepository",
  "src/libswamp/models/output_get.ts: createModelOutputGetDeps: YamlOutputRepository",
  "src/libswamp/models/output_logs.ts: createModelOutputLogsDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/output_logs.ts: createModelOutputLogsDeps: YamlOutputRepository",
  "src/libswamp/models/validate.ts: createModelValidateDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/models/validate.ts: createModelValidateDeps: YamlDefinitionRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: YamlDefinitionRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: YamlWorkflowRepository",
  "src/libswamp/workflows/evaluate.ts: createWorkflowEvaluateDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/workflows/evaluate.ts: createWorkflowEvaluateDeps: YamlDefinitionRepository",
  "src/libswamp/workflows/history_get.ts: createWorkflowHistoryGetDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/workflows/history_get.ts: createWorkflowHistoryGetDeps: YamlWorkflowRepository",
  "src/libswamp/workflows/history_get.ts: createWorkflowHistoryGetDeps: YamlWorkflowRunRepository",
  "src/libswamp/workflows/history_logs.ts: createWorkflowHistoryLogsDeps: YamlWorkflowRepository",
  "src/libswamp/workflows/history_logs.ts: createWorkflowHistoryLogsDeps: YamlWorkflowRunRepository",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowApprovals: YamlEvaluatedWorkflowRepository",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowApprove: YamlEvaluatedWorkflowRepository",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowReject: YamlEvaluatedWorkflowRepository",
  "src/serve/deps.ts: createWorkflowRunDeps: YamlEvaluatedWorkflowRepository",
  "src/serve/nested_run_cascade.ts: serveNestedCascade: YamlEvaluatedWorkflowRepository",
  "src/serve/suspended_run_cancel.ts: cancelSuspendedRunAndPush: YamlEvaluatedWorkflowRepository",
  "src/infrastructure/persistence/repository_factory.ts: createDefinitionRepository: YamlDefinitionRepository",
  "src/infrastructure/persistence/repository_factory.ts: createWorkflowRepository: YamlWorkflowRepository",
  // Fallback only: every CLI and serve caller injects the hooked repoContext repository.
  "src/libswamp/data/delete.ts: createDataDeleteDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/rename.ts: createDataRenameDeps: FileSystemUnifiedDataRepository",
  // The CLI writes through these, then runManagedConfigMutation sends a bare
  // mark (managedConfig only); serve injects the hooked repository.
  "src/libswamp/models/create.ts: createModelCreateDeps: YamlDefinitionRepository",
  "src/libswamp/models/edit.ts: createModelEditDeps: YamlDefinitionRepository",
  "src/libswamp/workflows/create.ts: createWorkflowCreateDeps: YamlWorkflowRepository",
  // gap: evaluated definitions and workflows are written to the datastore tier
  // and nothing marks them; serve never pushes after evaluate
  "src/libswamp/models/evaluate.ts: createModelEvaluateDeps: YamlEvaluatedDefinitionRepository",
  "src/libswamp/workflows/evaluate.ts: createWorkflowEvaluateDeps: YamlEvaluatedWorkflowRepository",
  // vault configs: read only, these never save or delete a vault config
  "src/cli/commands/datastore_setup.ts: nudgeVaultMigration: YamlVaultConfigRepository",
  "src/cli/commands/doctor_datastores.ts: createDoctorDatastoresDeps: YamlVaultConfigRepository",
  "src/cli/commands/serve.ts: serveCommand: YamlVaultConfigRepository",
  "src/cli/datastore_expression_resolver.ts: createEarlyVaultService: YamlVaultConfigRepository",
  "src/cli/mod.ts: initTelemetryService: YamlVaultConfigRepository",
  "src/domain/vaults/vault_service.ts: VaultService: YamlVaultConfigRepository",
  "src/libswamp/vaults/annotate.ts: createVaultAnnotateDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/delete.ts: createVaultDeleteDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/describe.ts: createVaultDescribeDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/get.ts: createVaultGetDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/inspect.ts: createVaultInspectDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/list_keys.ts: createVaultListKeysDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/put.ts: createVaultPutDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/read_secret.ts: createVaultReadSecretDeps: YamlVaultConfigRepository",
  // only lists run snapshots: doctor datastores --retention writes nothing
  "src/libswamp/datastores/retention_check.ts: checkSnapshots: YamlEvaluatedWorkflowRepository",
  "src/libswamp/datastores/setup.ts: createDatastoreSetupDeps: YamlVaultConfigRepository",
  // repo init writes the default vault into the new repo's own vaults/ before
  // any datastore is configured, so there is nothing to sync it to
  "src/libswamp/repo/init.ts: createRepoInitDeps: YamlVaultConfigRepository",
  // The CLI writes vault configs through these, then runManagedConfigMutation
  // sends a bare mark (managedConfig only); serve injects the hooked
  // repository.
  "src/libswamp/vaults/create.ts: createVaultCreateDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/edit.ts: createVaultEditDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/migrate.ts: createVaultMigrateDeps: YamlVaultConfigRepository",
];

// typed changes repositories stage before each write or remove: a write names a
// path that exists after, a remove one that is gone;
// repository_dirty_coverage_test checks this against the disk
const PINNED_STAGED_CHANGES: readonly string[] = [
  "src/infrastructure/persistence/unified_data_repository.ts: FileSystemUnifiedDataRepository remove (x11)",
  // reassertLatestVersion writes the version directory and latest marker;
  // deleting a name's newest version writes its version floor (v2 only)
  "src/infrastructure/persistence/unified_data_repository.ts: FileSystemUnifiedDataRepository write (x13)",
  "src/infrastructure/persistence/yaml_output_repository.ts: YamlOutputRepository remove (x3)",
  "src/infrastructure/persistence/yaml_output_repository.ts: YamlOutputRepository write",
  // "write|remove" is a delete whose resolved path is kept when it holds
  // another definition or workflow sharing the id
  "src/infrastructure/persistence/yaml_definition_repository.ts: YamlDefinitionRepository remove",
  "src/infrastructure/persistence/yaml_definition_repository.ts: YamlDefinitionRepository write",
  "src/infrastructure/persistence/yaml_definition_repository.ts: YamlDefinitionRepository write|remove",
  "src/infrastructure/persistence/yaml_evaluated_definition_repository.ts: YamlEvaluatedDefinitionRepository remove (x2)",
  "src/infrastructure/persistence/yaml_evaluated_definition_repository.ts: YamlEvaluatedDefinitionRepository write",
  "src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts: YamlEvaluatedWorkflowRepository remove (x3)",
  "src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts: YamlEvaluatedWorkflowRepository write (x2)",
  "src/infrastructure/persistence/yaml_workflow_repository.ts: YamlWorkflowRepository write",
  "src/infrastructure/persistence/yaml_workflow_repository.ts: YamlWorkflowRepository write|remove",
  "src/infrastructure/persistence/yaml_workflow_run_repository.ts: YamlWorkflowRunRepository remove (x3)",
  "src/infrastructure/persistence/yaml_workflow_run_repository.ts: YamlWorkflowRunRepository write",
  "src/infrastructure/persistence/yaml_vault_config_repository.ts: YamlVaultConfigRepository remove",
  "src/infrastructure/persistence/yaml_vault_config_repository.ts: YamlVaultConfigRepository write",
];

// production code that opens an ambient unit of work: withUnitOfWork wraps each
// write use case; runInRootUnitOfWork is the one root per command or request
// that use-case units nest in, and pushes once at its end
const PINNED_UNIT_OF_WORK_SCOPES: readonly string[] = [
  "src/infrastructure/persistence/repo_unit_of_work.ts: <module>",
  "src/infrastructure/persistence/repo_unit_of_work.ts: runInRootUnitOfWork",
  "src/libswamp/unit_of_work.ts: <module>",
  "src/libswamp/unit_of_work.ts: withUnitOfWork (x3)",
  // runInCommitLogRoot, the v3 commit-log root, is dormant: only tests call it
  // until the v3 opt-in
  "src/infrastructure/datastore_v3/commit_log_root.ts: <module>",
  "src/infrastructure/datastore_v3/commit_log_root.ts: runInCommitLogRoot",
  // the same root runs onRefused with itself ambient, so a run's re-save stages
  // into it
  "src/infrastructure/datastore_v3/commit_log_root.ts: settle",
];

// every libswamp use case that writes through a datastore-tier repository runs
// in a unit of work; read-only ones and those writing only secrets, lockfiles,
// credentials or raw files are not wrapped
const PINNED_TRANSACTIONAL_USE_CASES: readonly string[] = [
  "src/libswamp/access/token_create.ts: serverTokenCreate",
  "src/libswamp/access/token_revoke.ts: serverTokenRevoke",
  "src/libswamp/access/token_rotate.ts: serverTokenRotate",
  "src/libswamp/data/delete.ts: dataBatchDelete",
  "src/libswamp/data/delete.ts: dataDelete",
  "src/libswamp/data/gc.ts: dataGc",
  "src/libswamp/data/prune.ts: dataPrune",
  "src/libswamp/data/rename.ts: dataRename",
  "src/libswamp/data/run_gc.ts: runGc",
  "src/libswamp/models/create.ts: modelCreate",
  "src/libswamp/models/delete.ts: modelDelete",
  "src/libswamp/models/edit.ts: modelEdit",
  "src/libswamp/models/evaluate.ts: modelEvaluate",
  "src/libswamp/models/run.ts: modelMethodRun",
  "src/libswamp/vaults/create.ts: vaultCreate",
  "src/libswamp/vaults/edit.ts: vaultEdit",
  "src/libswamp/vaults/migrate.ts: vaultMigrate",
  "src/libswamp/vaults/remove.ts: vaultRemove",
  "src/libswamp/worker/prune.ts: workerPrune",
  "src/libswamp/worker/token_create.ts: workerTokenCreate",
  "src/libswamp/worker/token_revoke.ts: workerTokenRevoke",
  "src/libswamp/workflows/approve.ts: workflowApprove",
  "src/libswamp/workflows/cancel_suspended.ts: workflowCancelSuspended",
  "src/libswamp/workflows/create.ts: workflowCreate",
  "src/libswamp/workflows/delete.ts: workflowDelete",
  "src/libswamp/workflows/edit.ts: workflowEdit",
  "src/libswamp/workflows/evaluate.ts: workflowEvaluate",
  "src/libswamp/workflows/reject.ts: workflowReject",
  "src/libswamp/workflows/run.ts: workflowRun",
];

// Production references to the unit-of-work test seam. Empty: only tests
// install a factory, so production units always forward late changes.
const PINNED_UNIT_OF_WORK_SEAM_CALLERS: readonly string[] = [];

// production references to the unscoped-change test seams; empty because only
// tests replace or reset the route-2 warning
const PINNED_UNSCOPED_REPORTER_SEAM_CALLERS: readonly string[] = [];

// production callers that still write on route 2; the guard reads
// PINNED_UNSCOPED_WRITERS at runtime and this pins its keys. Empty: every
// route-2 caller runs in a root unit of work
const EXPECTED_UNSCOPED_WRITERS: readonly string[] = [];

// hook references in repositories other than signalChange's first argument;
// empty because repositories never call, pass on or store their hook
const PINNED_HOOK_MISUSES: readonly string[] = [];

// CLI write commands in a root unit of work whose flush is their push; commands
// on the global lock run in runInCoordinatorRoot, whose flush is the
// coordinator's push
const PINNED_CLI_ROOT_UNIT_COMMANDS: readonly string[] = [
  "src/cli/commands/access_grant.ts: accessGrantCreateCommand",
  "src/cli/commands/access_grant.ts: accessGrantRevokeCommand",
  "src/cli/commands/access_group.ts: runGroupMethod",
  "src/cli/commands/access_token_mint.ts: accessTokenMintCommand",
  "src/cli/commands/access_token_revoke.ts: accessTokenRevokeCommand",
  "src/cli/commands/access_token_rotate.ts: accessTokenRotateCommand",
  "src/cli/commands/data_delete.ts: dataDeleteCommand",
  "src/cli/commands/data_gc.ts: dataGcCommand",
  "src/cli/commands/data_prune.ts: dataPruneCommand",
  "src/cli/commands/data_rename.ts: dataRenameCommand",
  "src/cli/commands/datastore_compact.ts: datastoreCompactCommand",
  "src/cli/commands/datastore_config_migrate.ts: datastoreConfigMigrateCommand",
  // doctor datastores --repair rolls back unreadable data versions under the
  // affected models' locks
  "src/cli/commands/doctor_datastores.ts: createUnreadableVersionsRepairDeps",
  "src/cli/commands/model_create.ts: createModelCreateCommand",
  "src/cli/commands/model_delete.ts: createModelDeleteCommand",
  "src/cli/commands/model_edit.ts: createModelEditCommand",
  "src/cli/commands/model_evaluate.ts: createModelEvaluateCommand (x2)",
  "src/cli/commands/model_method_run.ts: createModelMethodRunCommand",
  "src/cli/commands/model_validate.ts: createModelValidateCommand",
  "src/cli/commands/run_gc.ts: runGcCommand",
  "src/cli/commands/vault_create.ts: vaultCreateCommand",
  "src/cli/commands/vault_edit.ts: vaultEditCommand",
  "src/cli/commands/vault_migrate.ts: vaultMigrateCommand",
  "src/cli/commands/vault_remove.ts: vaultRemoveCommand",
  "src/cli/commands/worker_prune.ts: workerPruneCommand",
  "src/cli/commands/worker_token_create.ts: workerTokenCreateCommand",
  "src/cli/commands/worker_token_revoke.ts: workerTokenRevokeCommand",
  "src/cli/commands/workflow_create.ts: workflowCreateCommand",
  "src/cli/commands/workflow_delete.ts: workflowDeleteCommand",
  "src/cli/commands/workflow_edit.ts: workflowEditCommand",
  "src/cli/commands/workflow_evaluate.ts: workflowEvaluateCommand (x2)",
  "src/cli/commands/workflow_resume.ts: workflowResumeCommand",
  "src/cli/commands/workflow_run.ts: workflowRunCommand",
  // commands that push nothing, in a root with no push, so their saves stage
  // into it rather than through signalChange's hook fallback
  "src/cli/commands/model_cancel.ts: createModelCancelCommand (x2)",
  "src/cli/commands/run.ts: runDoctorCommand",
  "src/cli/commands/workflow_cancel.ts: workflowCancelCommand (x2)",
  "src/cli/commands/workflow_recover.ts: workflowRecoverCommand",
  // their result waits for the root's commit
  "src/cli/commands/workflow_approve.ts: workflowApproveCommand",
  "src/cli/commands/workflow_reject.ts: workflowRejectCommand",
  // datastore gc sweeps chunks under the global lock's coordinator root, as
  // datastore compact runs
  "src/cli/commands/datastore_gc.ts: datastoreGcCommand",
  // datastore claim and release change the claim under the coordinator root, as
  // datastore gc runs
  "src/cli/commands/datastore_claim.ts: datastoreClaimCommand",
  "src/cli/commands/datastore_release.ts: datastoreReleaseCommand",
];

// callers of ModelLockResult.flush (push, then release) whose push is not a
// root's flush; no CLI command or serve method run remains
const PINNED_LOCK_FLUSH_CALLERS: readonly string[] = [
  // per-step locks inside a workflow run: the step's lock owns its push and
  // release
  "src/domain/workflows/execution_service.ts: DefaultStepExecutor",
];

// every production .pushChanged( call; commands and handlers reach a push only
// as a root unit's flush or checkpoint through the push paths, the rest are the
// coordinator and deliberate exceptions
const PINNED_DIRECT_PUSHES: readonly string[] = [
  // the push paths every root's flush or checkpoint calls; the managed lockfile
  // publish's checkpoint calls pushNamespaceCounted directly for the count and
  // the bound
  "src/infrastructure/persistence/push_paths.ts: pushModelLockScope (x3)",
  "src/infrastructure/persistence/push_paths.ts: pushNamespaceCounted",
  // the coordinator's push, made by runInCoordinatorRoot's flush and the mod.ts
  // teardown safety net
  "src/infrastructure/persistence/datastore_sync_coordinator.ts: flushDatastoreSyncNamed",
  // deliberate exception: datastore sync owns its pull and push by design
  "src/cli/commands/datastore_sync.ts: datastoreSyncCommand",
  "src/libswamp/datastores/sync.ts: createDatastoreSyncDeps (x2)",
  "src/libswamp/datastores/setup.ts: datastoreSetupExtension",
  // serve start-up migration and token GC run outside any request
  "src/cli/commands/serve.ts: serveCommand (x2)",
  "src/serve/token_secret_migration.ts: createTokenMigrationLockDeps",
  "src/serve/bookkeeping_gc.ts: reapBatch",
  "src/serve/worker_gc_service.ts: pruneWorkersAndPush",
];

const PINNED_CHECKPOINT_CALLS: readonly string[] = [
  // a root's checkpoint: the CLI commands that push mid-command
  "src/cli/commands/access_token_mint.ts: accessTokenMintCommand",
  "src/cli/commands/datastore_config_migrate.ts: datastoreConfigMigrateCommand",
  "src/cli/commands/worker_token_create.ts: workerTokenCreateCommand",
  "src/cli/commands/worker_token_revoke.ts: workerTokenRevokeCommand",
  // the managed extension lockfile publish, CLI and serve: stages the lockfile
  // into the transaction's root and pushes at that root's checkpoint, under the
  // global lock
  "src/libswamp/extensions/managed_lockfile_transaction.ts: createRootLockfileSync",
  "src/infrastructure/persistence/repo_unit_of_work.ts: runInRootUnitOfWork",
  // the v3 commit-log root's view hands checkpoint to its unit, which commits
  // the partitions touched so far; dormant
  "src/infrastructure/datastore_v3/commit_log_root.ts: runInCommitLogRoot",
  // before a run's root commits, its checkpoint finds a refusal to settle with
  // onRefused; dormant
  "src/infrastructure/datastore_v3/commit_log_root.ts: settleRefusals",
  // the catalog's SQLite WAL checkpoint shares the name and pushes nothing
  "src/cli/commands/datastore_compact.ts: datastoreCompactCommand",
  "src/libswamp/data/gc.ts: createDataGcDepsFrom",
  "src/libswamp/data/prune.ts: createDataPruneDeps",
  // after a retention pass, serve's timer and the CLI's end-of-command pass
  // checkpoint the catalog's WAL
  "src/cli/commands/serve.ts: serveCommand",
  "src/cli/retention_teardown.ts: runRetentionAtCommandEnd",
  "src/libswamp/datastores/compact.ts: datastoreCompact",
  // a v3 root's checkpoint commits the partitions touched so far, then runs the
  // checkpoint option it was given; the managed lockfile's v3 publish commits
  // at its root's checkpoint
  "src/infrastructure/persistence/repo_unit_of_work.ts: runInCommitLogEngineRoot (x2)",
  "src/infrastructure/datastore_v3/v3_lockfile_sync.ts: createV3LockfileSync",
  // a workflow run checkpoints as it saves its record so a crashed v3 run keeps
  // its record and completed steps' data; it pushes nothing on v2
  "src/domain/workflows/execution_service.ts: WorkflowExecutionService",
  "src/infrastructure/datastore_v3/commit_log_unit_of_work.ts: checkpointFrom",
];

// the unit-of-work binding registry is the one production change the v3
// commit-log unit shares with v2; pinning its callers keeps v2 routing where
// the characterization suites prove it
const BIND_CALL = /\bunitOfWorkBinding\.bind\s*\(/g;
const BOUND_HOOK_CALL = /\bunitOfWorkBinding\.boundHook\s*\(/g;
const REQUIRE_UNIT_CALL = /\bunitOfWorkBinding\.requireUnit\s*\(/g;
const LEGACY_TARGET_CALL = /\blegacyUnitOfWorkTarget\s*\(/g;
// the typed-stager registry beside it: which units take a repository's typed
// changes
const TYPED_STAGER_REGISTER_CALL = /\btypedStagers\.register\s*\(/g;
const TYPED_STAGER_LOOKUP_CALL = /\btypedStagers\.stagerOf\s*\(/g;

// the adapters that bind the units they build: the legacy adapter and the v3
// commit-log adapter
const PINNED_UNIT_OF_WORK_BINDERS: readonly string[] = [
  "src/infrastructure/datastore_v3/commit_log_unit_of_work.ts: createCommitLogUnitOfWork",
  "src/infrastructure/persistence/legacy_unit_of_work.ts: createLegacyUnitOfWork",
];

// who asks which hook a unit is bound to: signalChange's routing and the
// legacy-only view of the binding
const PINNED_BOUND_HOOK_READERS: readonly string[] = [
  "src/infrastructure/persistence/legacy_unit_of_work.ts: legacyUnitOfWorkTarget",
  "src/infrastructure/persistence/unit_of_work_scope.ts: signalChange (x2)",
  // the typed route (stageTyped, typedStagingActive) stages only into a unit
  // bound to the repository's hook; (x2) because an unbound unit must not hide
  // the bound v3 unit around it
  "src/infrastructure/persistence/unit_of_work_scope.ts: boundTypedStager (x2)",
  // version allocation finds the unit's version-floor source the way the typed
  // route finds its stager
  "src/infrastructure/persistence/unit_of_work_scope.ts: versionFloorSource (x2)",
];

// who registers a unit as taking typed changes: only the v3 commit-log adapter
const PINNED_TYPED_STAGER_REGISTRARS: readonly string[] = [
  "src/infrastructure/datastore_v3/commit_log_unit_of_work.ts: createCommitLogUnitOfWork",
];

// who asks whether a unit takes typed changes: signalChange's routing (a typed
// declaration stages no path) and the typed route's lookup
const PINNED_TYPED_STAGER_LOOKUPS: readonly string[] = [
  // (x2) because an unbound unit must not hide the v3 unit around it that is
  // bound to the write's hook
  "src/infrastructure/persistence/unit_of_work_scope.ts: boundTypedStager (x2)",
  "src/infrastructure/persistence/unit_of_work_scope.ts: signalChange (x2)",
  // whether a unit is v3, which withUnitOfWork asks in order to end it
  "src/infrastructure/persistence/unit_of_work_scope.ts: takesTypedChanges",
  // the innermost v3 unit around a call, which a repository with no hook stages
  // into (adoptingStager), tracked when a typed-changes unit runs
  "src/infrastructure/persistence/unit_of_work_scope.ts: adoptingStager",
  "src/infrastructure/persistence/unit_of_work_scope.ts: runInUnitOfWork",
];

// who marks a context as refusing writes outside a unit: only the v3 commit-log
// root; the v3 opt-in adds the context factory here
const PINNED_REQUIRE_UNIT_CALLERS: readonly string[] = [
  "src/infrastructure/datastore_v3/commit_log_root.ts: runInCommitLogRoot",
  // a v3 repository context is marked when built, so a write before any root
  // opens is refused too
  "src/infrastructure/persistence/repository_factory.ts: createRepositoryContext",
];

// legacyUnitOfWorkTarget, the legacy-only view: its definition, the legacy
// adapter's parent lookup, and signalChange's refusal to stage a v3 hook's
// write into a legacy unit
const PINNED_LEGACY_TARGET_CALLS: readonly string[] = [
  "src/infrastructure/persistence/legacy_unit_of_work.ts: legacyParentFor",
  "src/infrastructure/persistence/legacy_unit_of_work.ts: legacyUnitOfWorkTarget",
  "src/infrastructure/persistence/unit_of_work_scope.ts: signalChange",
];

const files = await sourceFiles();

Deno.test("datastore write seams: direct mark calls are pinned (swamp-club#2856)", () => {
  assertPinnedSet(
    markCallSites(files),
    PINNED_MARK_CALL_SITES,
    "Direct markDirty / notifyDirty / markDirtyHook / markDirtyBulk calls",
    "New code must not call markDirty directly; stage writes through the unit\n" +
      "of work (datastore refactor Phase 1). If this is intentional, add it\n" +
      "here with a reason.",
  );
});

Deno.test("datastore write seams: repository constructions outside the factory are pinned (swamp-club#2856)", () => {
  assertPinnedSet(
    repositoryConstructions(files),
    PINNED_REPO_CONSTRUCTIONS,
    "Datastore-tier repositories constructed outside repository_factory.ts",
    "New code must not construct datastore-tier repositories directly; take\n" +
      "them from createRepositoryContext so the unit of work can reach them.\n" +
      "If this is intentional, add it here with a reason.",
  );
});

Deno.test("datastore write seams: repositories built without a mark hook are pinned (swamp-club#2856)", () => {
  assertPinnedSet(
    unhookedWriters(files),
    PINNED_UNHOOKED_WRITERS,
    "Hook-taking repositories constructed without a mark hook",
    "A repository built without its mark hook writes files that sync never\n" +
      "pushes. Pass repoContext.markDirty (or take the repository from\n" +
      "createRepositoryContext). If it only reads, add it here under the\n" +
      "read-only group.",
  );
});

Deno.test("datastore write seams: hook argument positions match the constructors", async () => {
  for (const [className, { index, file }] of Object.entries(HOOK_ARGUMENT)) {
    const code = await Deno.readTextFile(
      join(SRC_DIR, "infrastructure", "persistence", file),
    );
    const start = code.indexOf(`class ${className}`);
    const constructor = code.indexOf("constructor(", start);
    const params = code.slice(constructor + "constructor(".length).split(
      /\)\s*\{/,
    )[0]
      .split("\n")
      .filter((line) => !isCommentLine(line))
      .join("\n")
      .split(",")
      .map((param) => param.trim())
      .filter((param) => param !== "");
    assertEquals(
      /\bmarkDirty(?:Hook)?\?:/.test(params[index] ?? ""),
      true,
      `${className}: expected the mark hook at argument ${index}, found ` +
        `"${params[index]}". Update HOOK_ARGUMENT.`,
    );
  }
});

Deno.test("datastore write seams: production code opening a unit-of-work scope is pinned (swamp-club#2971)", () => {
  assertPinnedSet(
    unitOfWorkScopes(files),
    PINNED_UNIT_OF_WORK_SCOPES,
    "Production runInUnitOfWork references (calls and imports)",
    "Only withUnitOfWork and runInRootUnitOfWork open a unit-of-work scope.\n" +
      "A use case that needs one wraps its body in withUnitOfWork, and a\n" +
      "command or request runs in runInRootUnitOfWork, instead of calling\n" +
      "runInUnitOfWork itself.",
  );
});

Deno.test("datastore write seams: the unit-of-work scope scan finds calls and aliased imports, not comments", () => {
  const probe: SourceFile = {
    rel: "src/libswamp/probe.ts",
    code: "",
    lines: [
      'import { runInUnitOfWork as scope } from "../scope.ts";',
      "export async function probe() {",
      "  await runInUnitOfWork(uow, () => work());",
      "  // runInUnitOfWork(uow, fn) in a comment is not a reference",
      "}",
    ],
    owners: ["<module>", "probe", "probe", "probe", "probe"],
  };
  assertEquals(unitOfWorkScopes([probe]), [
    "src/libswamp/probe.ts: <module>",
    "src/libswamp/probe.ts: probe",
  ]);
});

Deno.test("datastore write seams: use cases that run inside a unit of work are pinned (swamp-club#3025)", () => {
  assertPinnedSet(
    transactionalUseCases(files),
    PINNED_TRANSACTIONAL_USE_CASES,
    "libswamp use cases wrapped in withUnitOfWork",
    "A write use case must run its body through withUnitOfWork so its\n" +
      "repositories stage into one unit of work. Add new write use cases here;\n" +
      "remove one only when it no longer writes through a datastore-tier\n" +
      "repository.",
  );
});

Deno.test("datastore write seams: the transactional use-case scan counts exported wraps, not helpers or comments", () => {
  const probe: SourceFile = {
    rel: "src/libswamp/probe.ts",
    code: [
      "export async function* probeWrite(ctx) {",
      "export function probeReturn(ctx) {",
      "async function* helper(ctx) {",
    ].join("\n"),
    lines: [
      "export async function* probeWrite(ctx) {",
      "  yield* withUnitOfWork(ctx, () =>",
      "}",
      "export function probeReturn(ctx) {",
      "  return withUnitOfWork(ctx, () => body());",
      "  // yield* withUnitOfWork(ctx, fn) in a comment does not count",
      "}",
      "async function* helper(ctx) {",
      "  yield* withUnitOfWork(ctx, () => body());",
      "}",
    ],
    owners: [
      "probeWrite",
      "probeWrite",
      "probeWrite",
      "probeReturn",
      "probeReturn",
      "probeReturn",
      "probeReturn",
      "helper",
      "helper",
      "helper",
    ],
  };
  assertEquals(transactionalUseCases([probe]), [
    "src/libswamp/probe.ts: probeReturn",
    "src/libswamp/probe.ts: probeWrite",
  ]);
});

Deno.test("datastore write seams: the unscoped-change reporter seam has no production callers (swamp-club#3056)", () => {
  assertPinnedSet(
    unscopedReporterSeamCallers(files),
    PINNED_UNSCOPED_REPORTER_SEAM_CALLERS,
    "Production references to the unscoped-change test seams",
    "Only tests may replace the route-2 reporter or reset its warnings.\n" +
      "Production keeps the warning, so an unscoped write in the field is\n" +
      "still visible.",
  );
});

Deno.test("datastore write seams: production writers still on route 2 are pinned with a reason (swamp-club#3056)", async () => {
  assertEquals(
    PINNED_UNSCOPED_WRITERS.map((pin) => pin.writer).sort(),
    [...EXPECTED_UNSCOPED_WRITERS].sort(),
    "PINNED_UNSCOPED_WRITERS changed. Prefer running the writer in a root\n" +
      "unit of work; pin it only when that would change behaviour.",
  );
  for (const { writer, reason } of PINNED_UNSCOPED_WRITERS) {
    const [file, fn] = writer.split(": ");
    const code = await Deno.readTextFile(join(SRC_DIR, "..", file));
    assertEquals(code.includes(fn), true, `${writer}: function not found`);
    assertEquals(reason.trim() !== "", true, `${writer}: give a reason`);
  }
});

Deno.test("datastore write seams: the unit-of-work test seam has no production callers (swamp-club#3025)", () => {
  assertPinnedSet(
    unitOfWorkSeamCallers(files),
    PINNED_UNIT_OF_WORK_SEAM_CALLERS,
    "Production references to useUnitOfWorkFactoryForTesting",
    "Only tests may install a unit-of-work factory. Production units must\n" +
      "forward a change staged after commit instead of rejecting it.",
  );
});

Deno.test("datastore write seams: typed changes repositories stage are pinned (swamp-club#2979)", () => {
  assertPinnedSet(
    stagedChanges(files),
    PINNED_STAGED_CHANGES,
    "Typed write / remove / bulk changes staged by datastore-tier repositories",
    "A repository changed how it signals a write. Check each staged kind\n" +
      "matches the disk after the operation (write: the path exists, remove:\n" +
      "it is gone), then update the counts here.",
  );
});

Deno.test("datastore write seams: the staged-change scan counts wrapped literals inside repository classes, not comments", () => {
  const probe: SourceFile = {
    rel: "src/infrastructure/persistence/probe.ts",
    code: "",
    lines: [
      'const outside = { kind: "write", path: "/a" };',
      "export class YamlOutputRepository {",
      '  // { kind: "remove", path } in a comment is not a change',
      '    await this.stage({ kind: "write", path });',
      "    await this.stage({",
      '      kind: "remove",',
      "      path: this.pathFor(id),",
      "    });",
      "    await this.stage({",
      '      kind: kept ? "write" : "remove",',
      "      path,",
      "    });",
      "}",
    ],
    owners: [
      "outside",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
      "YamlOutputRepository",
    ],
  };
  assertEquals(stagedChanges([probe]), [
    "src/infrastructure/persistence/probe.ts: YamlOutputRepository remove",
    "src/infrastructure/persistence/probe.ts: YamlOutputRepository write",
    "src/infrastructure/persistence/probe.ts: YamlOutputRepository write|remove",
  ]);
});

Deno.test("datastore write seams: only the unit-of-work adapters call a mark hook in the persistence layer (swamp-club#2996)", () => {
  assertPinnedSet(
    persistenceMarksOutsideAdapters(files),
    [],
    "Mark calls under src/infrastructure/persistence/ outside the unit-of-work adapters",
    "Repositories never call a mark hook: stage each change through\n" +
      "signalChange(this.<hook>, { kind, path }) instead of pinning the call.\n" +
      "A new unit-of-work adapter that forwards staged changes belongs in\n" +
      "PERSISTENCE_MARK_ADAPTERS with its reason.",
  );
});

Deno.test("datastore write seams: the persistence mark scan reports repositories, not the adapters or other layers", () => {
  const probe = (rel: string, lines: string[]): SourceFile => ({
    rel,
    code: lines.join("\n"),
    lines,
    owners: topLevelOwners(lines),
  });
  const found = persistenceMarksOutsideAdapters([
    probe("src/infrastructure/persistence/probe_repository.ts", [
      "export class ProbeRepository {",
      "  async save(path: string) {",
      "    await this.markDirty?.(path);",
      "  }",
      "}",
    ]),
    probe("src/infrastructure/persistence/legacy_unit_of_work.ts", [
      "export async function createLegacyUnitOfWork() {",
      "  await markDirty(path);",
      "}",
    ]),
    probe("src/infrastructure/persistence/unit_of_work_scope.ts", [
      "export async function signalChange() {",
      "  await markDirty(path);",
      "}",
    ]),
    probe("src/cli/commands/probe.ts", [
      "export async function probeCommand() {",
      "  await repoContext.markDirty?.(path);",
      "}",
    ]),
  ]);
  assertEquals(found, [
    "src/infrastructure/persistence/probe_repository.ts: ProbeRepository",
  ]);
});

Deno.test("datastore write seams: repositories reference their hook only as signalChange's or stageTyped's first argument (swamp-club#2996, swamp-club#3250)", () => {
  assertPinnedSet(
    hookReferencesOutsideSignalChange(files),
    PINNED_HOOK_MISUSES,
    "Datastore-tier repository hook references outside signalChange",
    "A repository reaches its mark hook only as the first argument of\n" +
      "signalChange(this.<hook>, change), stageTyped(this.<hook>, build) or\n" +
      "typedStagingActive(this.<hook>), or looks up its unit's version floor\n" +
      "with versionFloorSource(this.<hook>), its filter with\n" +
      "unitAdmitsKey(this.<hook>, key), or reads a key's committed version\n" +
      "or whether it forwards with storedVersionOf(this.<hook>, …) or\n" +
      "forwardsToServe(this.<hook>), so the unit of work sees every\n" +
      "change.\n" +
      "Do not call the hook, pass it on, or store it.",
  );
});

Deno.test("datastore write seams: the hook reference scan catches calls and pass-throughs, not wrapped signalChange, comments or the constructor parameter", () => {
  const lines = [
    "export class YamlOutputRepository {",
    "  constructor(",
    "    private readonly markDirty?: MarkDirtyHook,",
    "  ) {}",
    "  // this.markDirty(path) in a comment is not a reference",
    "  async a() {",
    '    await signalChange(this.markDirty, { kind: "write", path });',
    "    await signalChange(",
    "      this.markDirty,",
    '      { kind: "remove", path },',
    "    );",
    "    await stageTyped(this.markDirty, () => changes);",
    "    if (typedStagingActive(this.markDirty)) read();",
    "    const floors = versionFloorSource(this.markDirty);",
    "    const kept = unitAdmitsKey(this.markDirty, key);",
    "    const stored = await storedVersionOf(this.markDirty, p, key);",
    "    if (forwardsToServe(this.markDirty)) return;",
    "    await stageTyped(",
    "      this.markDirty,",
    "      () => changes,",
    "    );",
    "    await this.markDirty(path);",
    "    await this.markDirtyHook?.();",
    "    other(this.markDirty);",
    "    const hook = this.markDirty;",
    "  }",
    "}",
    "export class Unrelated {",
    "  b() {",
    "    this.markDirty(path);",
    "  }",
    "}",
  ];
  const probe: SourceFile = {
    rel: "src/infrastructure/persistence/probe.ts",
    code: lines.join("\n"),
    lines,
    owners: topLevelOwners(lines),
  };
  assertEquals(hookReferencesOutsideSignalChange([probe]), [
    "src/infrastructure/persistence/probe.ts: YamlOutputRepository (x4)",
  ]);
});

Deno.test("datastore write seams: CLI commands that run in a root unit of work are pinned (swamp-club#3033)", () => {
  assertPinnedSet(
    referenceKeys(files, CLI_ROOT_CALL, inCliCommands),
    PINNED_CLI_ROOT_UNIT_COMMANDS,
    "CLI commands opening a root unit of work",
    "A CLI write command runs its write section in runCommandInRootUnit (or\n" +
      "runManagedConfigMutation), whose flush is the command's push. Add the\n" +
      "command here when it adopts a root.",
  );
});

Deno.test("datastore write seams: callers of a lock's combined flush are pinned (swamp-club#3033)", () => {
  assertPinnedSet(
    referenceKeys(files, LOCK_FLUSH_REFERENCE, () => true),
    PINNED_LOCK_FLUSH_CALLERS,
    "ModelLockResult.flush references",
    "A CLI command pushes through its root unit (lockResult.push as the\n" +
      "root's flush) and releases with lockResult.release after the root\n" +
      "ends. Use flush() only where no root is opened, and say why here.",
  );
});

Deno.test("datastore write seams: every production push is a push path, the coordinator, or a pinned exception (swamp-club#3055)", () => {
  assertPinnedSet(
    referenceKeys(files, PUSH_CALL, () => true),
    PINNED_DIRECT_PUSHES,
    "pushChanged calls in src",
    "Push through a root unit's flush or checkpoint, passing a function from\n" +
      "src/infrastructure/persistence/push_paths.ts rather than calling pushChanged. A push that\n" +
      "cannot be a root's must be pinned here, in the deliberate-exceptions\n" +
      "group, with the reason.",
  );
});

Deno.test("datastore write seams: checkpoint calls are pinned (swamp-club#3053)", () => {
  assertPinnedSet(
    referenceKeys(files, CHECKPOINT_CALL, () => true),
    PINNED_CHECKPOINT_CALLS,
    ".checkpoint() calls",
    "A mid-operation push goes through the root's checkpoint. Add the caller\n" +
      "here, in the group it belongs to, with the push it replaces.",
  );
});

Deno.test("datastore write seams: the reference scan counts calls per owner, not comments", () => {
  const probe: SourceFile = {
    rel: "src/cli/commands/probe.ts",
    code: "",
    lines: [
      "export const probeCommand = async () => {",
      "  await runCommandInRootUnit(repoContext, {}, () => work());",
      "  // runCommandInRootUnit(repoContext, {}, fn) in a comment",
      "  await syncService.pushChanged({ namespace });",
      "  await syncService.pushChanged({ namespace });",
      "  await root.checkpoint();",
      "  // await root.checkpoint() in a comment",
      "  catalogStore.checkpoint();",
      "};",
    ],
    owners: Array(9).fill("probeCommand"),
  };
  assertEquals(referenceKeys([probe], CLI_ROOT_CALL, inCliCommands), [
    "src/cli/commands/probe.ts: probeCommand",
  ]);
  assertEquals(referenceKeys([probe], PUSH_CALL, inCliCommands), [
    "src/cli/commands/probe.ts: probeCommand (x2)",
  ]);
  assertEquals(referenceKeys([probe], PUSH_CALL, () => false), []);
  const serveProbe: SourceFile = {
    rel: "src/serve/probe.ts",
    code: "",
    lines: [
      "export async function probeHandler() {",
      "  // syncService.pushChanged({ namespace }) in a comment",
      "  await deps.syncService?.pushChanged({ namespace });",
      "}",
    ],
    owners: Array(4).fill("probeHandler"),
  };
  assertEquals(referenceKeys([probe, serveProbe], PUSH_CALL, () => true), [
    "src/cli/commands/probe.ts: probeCommand (x2)",
    "src/serve/probe.ts: probeHandler",
  ]);
  assertEquals(referenceKeys([probe], CHECKPOINT_CALL, () => true), [
    "src/cli/commands/probe.ts: probeCommand (x2)",
  ]);
});

Deno.test("datastore write seams: only the unit-of-work adapters bind units (swamp-club#3240)", () => {
  assertPinnedSet(
    referenceKeys(files, BIND_CALL, () => true),
    PINNED_UNIT_OF_WORK_BINDERS,
    "unitOfWorkBinding.bind calls",
    "A unit of work is bound to its repository context by the adapter that\n" +
      "builds it. Add an adapter here only with the routing it changes.",
  );
});

Deno.test("datastore write seams: routing reads the binding registry in pinned places (swamp-club#3240)", () => {
  assertPinnedSet(
    referenceKeys(files, BOUND_HOOK_CALL, () => true),
    PINNED_BOUND_HOOK_READERS,
    "unitOfWorkBinding.boundHook calls",
    "signalChange decides where a write goes. Route through it rather than\n" +
      "asking the registry elsewhere.",
  );
});

Deno.test("datastore write seams: only the v3 commit-log root marks a context as refusing unscoped writes (swamp-club#3240)", () => {
  assertPinnedSet(
    referenceKeys(files, REQUIRE_UNIT_CALL, () => true),
    PINNED_REQUIRE_UNIT_CALLERS,
    "unitOfWorkBinding.requireUnit calls",
    "requireUnit makes a context refuse writes outside a unit: a v3\n" +
      "datastore's. A v2 context must never be marked, or its route-2\n" +
      "writes start failing.",
  );
});

Deno.test("datastore write seams: only the v3 commit-log adapter registers typed stagers (swamp-club#3250)", () => {
  assertPinnedSet(
    referenceKeys(files, TYPED_STAGER_REGISTER_CALL, () => true),
    PINNED_TYPED_STAGER_REGISTRARS,
    "typedStagers.register calls",
    "A unit registered as a typed stager takes a repository's typed changes\n" +
      "instead of its path changes. Only the v3 commit-log unit does.",
  );
});

Deno.test("datastore write seams: typed staging is looked up only by the routing (swamp-club#3250)", () => {
  assertPinnedSet(
    referenceKeys(files, TYPED_STAGER_LOOKUP_CALL, () => true),
    PINNED_TYPED_STAGER_LOOKUPS,
    "typedStagers.stagerOf calls",
    "signalChange and stageTyped decide where a write goes. Route through\n" +
      "them rather than asking the registry elsewhere.",
  );
});

Deno.test("datastore write seams: legacyUnitOfWorkTarget stays inside the legacy adapter (swamp-club#3240)", () => {
  assertPinnedSet(
    referenceKeys(files, LEGACY_TARGET_CALL, () => true),
    PINNED_LEGACY_TARGET_CALLS,
    "legacyUnitOfWorkTarget references",
    "signalChange asks the binding registry (unit_of_work_binding.ts), which\n" +
      "every adapter binds through. legacyUnitOfWorkTarget is the legacy-only\n" +
      "view of it.",
  );
});

/**
 * every read of which engine a datastore opens with; the marker decides once at
 * the format guard and later code follows the repository context, so the choice
 * cannot spread. A new read needs a reason
 */
const ENGINE_READ =
  /\b(?:checkedDatastoreEngine|datastoreEngineOf|resolverEngine)\s*\(/g;

const PINNED_ENGINE_READERS: readonly string[] = [
  // the definitions, and the guard's own cache read
  "src/domain/datastore/datastore_path_resolver.ts: resolverEngine",
  "src/infrastructure/persistence/datastore_format_guard.ts: checkedDatastoreEngine",
  "src/infrastructure/persistence/datastore_format_guard.ts: datastoreEngineOf",
  // the engine of the datastore a .swamp.yaml block names, read by setup (to
  // refuse moving off v3) and the CLI's managed lockfile transaction
  "src/infrastructure/persistence/datastore_format_guard.ts: datastoreBlockEngine",
  // whether an extension datastore syncs the v2 way
  "src/infrastructure/persistence/datastore_format_guard.ts: isV2CustomDatastore",
  // a lock asked of a v3 bucket datastore no binding has seen is refused, never
  // taken the v2 way in its bucket
  "src/infrastructure/persistence/datastore_lock_target.ts: lockingConfigOf",
  // a resolver resolves records into the checkout on v3
  "src/infrastructure/persistence/default_datastore_path_resolver.ts: DefaultDatastorePathResolver",
  // the macOS ordering barrier is for v2 writes only; a v3 repository syncs in
  // full, reading the engine the context opened
  "src/infrastructure/persistence/ordered_sync.ts: selectDurableWriteSync",
  // the catalog is the read model's on v3; there is no shared-datastore write
  // tracker
  "src/infrastructure/persistence/repository_factory.ts: catalogDbPath",
  "src/infrastructure/persistence/repository_factory.ts: sharedDatastoreWriteTracker",
  // commands that act on the v3 datastore itself: chunk GC, status, and serve's
  // compaction timer and status handler
  "src/cli/commands/datastore_gc.ts: datastoreGcCommand",
  "src/cli/commands/datastore_status.ts: datastoreStatusCommand",
  "src/cli/commands/serve.ts: serveCommand",
  "src/serve/handlers/admin_handlers.ts: handleDatastoreStatus",
  // a claim and a release apply only to a v3 datastore's commit log, CLI and
  // serve
  "src/cli/commands/datastore_claim.ts: datastoreClaimCommand",
  "src/cli/commands/datastore_release.ts: datastoreReleaseCommand",
  "src/serve/handlers/admin_handlers.ts: serveClaimCommitLog",
  // a traced dashboard read records the engine as a span attribute; nothing is
  // chosen by it
  "src/serve/connection.ts: handleMessage",
  // serve's doctor datastores adds the v3 content check (unreadable records,
  // at-risk copies, torn chunks) on a v3 datastore
  "src/serve/handlers/admin_handlers.ts: handleDoctorDatastores",
  // datastore namespace list: a v3 datastore has no namespace manifests, so its
  // commits.db names them; a v2 extension datastore goes to its provider, a v3
  // one to its commits
  "src/libswamp/datastores/namespace_list.ts: createNamespaceListDeps (x2)",
  // doctor datastores --retention reports a v3 datastore's history
  "src/libswamp/datastores/retention_check.ts: retentionScanSourcesFor",
  // commands v3 refuses choose a read-only open first, so the refusal takes no
  // writer lease and changes nothing; their deps refuse a v3 datastore on a
  // bucket too
  "src/cli/repo_context.ts: peekRepoDatastoreEngine",
  "src/libswamp/datastores/migrate_index.ts: createMigrateIndexDeps",
  "src/libswamp/datastores/sync.ts: createDatastoreSyncDeps (x2)",
  // run-record artifacts resolve through resolveRunArtifact on v3
  "src/libswamp/data/run_artifact_check.ts: v3RunArtifactCheck",
  "src/libswamp/models/output_data.ts: createModelOutputDataDeps",
];

Deno.test("datastore write seams: reads of the datastore engine are pinned (swamp-club#3279)", () => {
  assertPinnedSet(
    referenceKeys(files, ENGINE_READ, () => true),
    PINNED_ENGINE_READERS,
    "Reads of the datastore engine",
    "The engine is chosen once, from the format marker. Code past the guard\n" +
      "follows the repository context; add a new read here only with a\n" +
      "reason.",
  );
});

/**
 * every production CatalogStore must use the path catalogDbPath names for its
 * engine; on v3 another path could reopen the v2 catalog over a v3 datastore
 * and answer from a disk walk
 */
const CATALOG_STORE_CONSTRUCTION = /\bnew CatalogStore\s*\(/g;

const PINNED_CATALOG_STORE_CONSTRUCTIONS: readonly string[] = [
  // The one route for a repository: catalogDbPath chooses by engine.
  "src/infrastructure/persistence/repository_factory.ts: createCatalogStore",
  // An in-memory catalog for ephemeral stores, never a repository's.
  "src/infrastructure/persistence/ephemeral_store.ts: createEphemeralStore",
  // the read model's own catalog, at v3CatalogPath, the path catalogDbPath
  // returns on v3
  "src/infrastructure/datastore_v3/v3_catalog.ts: V3Catalog",
  "src/infrastructure/datastore_v3/v3_datastore.ts: openV3Datastore",
];

Deno.test("datastore write seams: catalog stores are built on the catalog path for their engine (swamp-club#3279)", () => {
  assertPinnedSet(
    referenceKeys(files, CATALOG_STORE_CONSTRUCTION, () => true),
    PINNED_CATALOG_STORE_CONSTRUCTIONS,
    "CatalogStore constructions",
    "Build a repository's catalog with createCatalogStore, which takes its\n" +
      "path from catalogDbPath, so a v3 datastore reads the read model's\n" +
      "catalog.",
  );
});
