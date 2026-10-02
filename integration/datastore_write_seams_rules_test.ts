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

// Fitness ratchets on the datastore write seams that the datastore refactor
// moves (swamp-club#2856). Phase 1 puts a unit of work between repositories
// and the mark hook; phase 2 makes libswamp use cases own it. Pinning the
// seams now means no new one appears while that work is in flight, and each
// refactor PR shows its progress by shrinking these lists.
//
// Keys name the repo-relative file and the top-level declaration that holds
// the site, never a line number. A key that occurs more than once carries
// " (xN)", so a second site under an already pinned owner still fails.
//
// Reproduce the raw counts (non-test src/):
//   mark calls:
//     grep -rnE "\b(markDirty|notifyDirty|markDirtyHook|markDirtyBulk)\??\.?\(" src \
//       --include='*.ts' --include='*.tsx' | grep -v "_test.tsx\?:" \
//       | grep -vE ":\s*(//|\*)" | grep -vE "(async |private |public )(markDirty|notifyDirty)\("
//   repository constructions:
//     grep -rnE "new (YamlDefinition|FileSystemUnifiedData|YamlWorkflow|YamlWorkflowRun|YamlOutput|YamlEvaluatedWorkflow|YamlEvaluatedDefinition|YamlVaultConfig|JsonlAudit|JsonlVaultAudit|CompositeUnifiedData|Lockfile)Repository\b" src \
//       --include='*.ts' | grep -v "_test.ts:" | grep -v repository_factory.ts
// The grep counts differ slightly from the scans below: the scans also skip
// interface members and catch constructions split across lines.
//
// Passing a hook as a value (`markDirty: repoContext.markDirty`) is not a
// call and is not pinned here.

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
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

/** Test doubles that live under src/ but are not production code. */
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

// ---------------------------------------------------------------------------
// Rule 1: direct mark calls
// ---------------------------------------------------------------------------

const MARK_CALL =
  /\b(markDirty|notifyDirty|markDirtyHook|markDirtyBulk)\s*(?:\?\.)?\(/g;
// A modifier right before the name means a method or function definition.
const DEFINITION_PREFIX =
  /\b(?:async|private|public|protected|static|function|readonly|get|set)\s+(?:\*\s*)?$/;

/** Whether a mark name that starts its line is a definition, not a call. */
function isDefinitionLine(line: string): boolean {
  return /\)\s*:\s*[^=]*[;{]\s*$/.test(line) || // `name(...): T;` / `: T {`
    /\)\s*\{\s*$/.test(line) || // `name(...) {`
    /^\s*\w+\??\s*:/.test(line); // `name?: Hook`
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

// ---------------------------------------------------------------------------
// Rules 2 and 3: repository constructions
// ---------------------------------------------------------------------------

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

/** Zero-based position of the mark hook in each hook-taking constructor. */
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

// ---------------------------------------------------------------------------
// Pinned lists
// ---------------------------------------------------------------------------

const PINNED_MARK_CALL_SITES: readonly string[] = [
  // CLI commands that mark before pushing (several send bare marks).
  "src/cli/commands/access_grant.ts: accessGrantCreateCommand",
  "src/cli/commands/access_group.ts: runGroupMethod",
  "src/cli/commands/access_token_mint.ts: accessTokenMintCommand",
  "src/cli/commands/datastore_config_migrate.ts: datastoreConfigMigrateCommand",
  "src/cli/commands/datastore_namespace.ts: buildMigrateDeps",
  "src/cli/commands/datastore_sync.ts: datastoreSyncCommand",
  "src/cli/commands/serve.ts: serveCommand",
  "src/cli/commands/worker_prune.ts: workerPruneCommand",
  "src/cli/commands/worker_token_create.ts: workerTokenCreateCommand",
  "src/cli/commands/worker_token_revoke.ts: workerTokenRevokeCommand",
  // Managed-config push helpers.
  "src/cli/managed_config_sync.ts: pushManagedConfigChanges",
  "src/cli/managed_config_sync.ts: pushManagedConfigPaths",
  // The mark hook itself, and the catalog export.
  "src/cli/repo_context.ts: buildMarkDirtyHook (x2)",
  "src/cli/repo_context.ts: writeCatalogExportIfNeeded",
  // The legacy unit of work forwarding staged changes to the mark hook
  // (datastore rework Phase 1, swamp-club#2970). Exactly one call: later
  // phases stage through the unit of work rather than adding calls here.
  "src/infrastructure/persistence/legacy_unit_of_work.ts: createLegacyUnitOfWork",
  // Repositories notifying their mark hook after a write.
  "src/infrastructure/persistence/unified_data_repository.ts: FileSystemUnifiedDataRepository (x16)",
  "src/infrastructure/persistence/yaml_definition_repository.ts: YamlDefinitionRepository (x4)",
  "src/infrastructure/persistence/yaml_evaluated_definition_repository.ts: YamlEvaluatedDefinitionRepository (x4)",
  "src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts: YamlEvaluatedWorkflowRepository (x6)",
  "src/infrastructure/persistence/yaml_output_repository.ts: YamlOutputRepository (x5)",
  "src/infrastructure/persistence/yaml_workflow_repository.ts: YamlWorkflowRepository (x3)",
  "src/infrastructure/persistence/yaml_workflow_run_repository.ts: YamlWorkflowRunRepository (x5)",
  // Use cases that mark directly.
  "src/libswamp/datastores/namespace_migrate.ts: datastoreNamespaceMigrate",
  "src/libswamp/extensions/managed_lockfile_transaction.ts: createDatastoreLockfileSync",
  // Serve handlers marking written paths before pushChanged.
  "src/serve/device_auth_handler.ts: mintServerTokenImpl (x2)",
  "src/serve/grant_write_tracking.ts: publishGrantWrites",
  "src/serve/handlers/access_handlers.ts: handleAccessReload",
  "src/serve/handlers/admin_handlers.ts: extensionLockfileTransaction",
  "src/serve/handlers/admin_handlers.ts: handleVaultMigrate (x2)",
  "src/serve/handlers/vault_handlers.ts: handleVaultCreate",
  "src/serve/handlers/vault_handlers.ts: handleVaultEdit",
];

const PINNED_REPO_CONSTRUCTIONS: readonly string[] = [
  // Built directly in src/cli/commands/.
  "src/cli/commands/access_helpers.ts: buildModelMethodRunDeps: YamlDefinitionRepository",
  "src/cli/commands/audit.ts: recordHookEntry: JsonlAuditRepository",
  "src/cli/commands/datastore_setup.ts: nudgeVaultMigration: YamlVaultConfigRepository",
  "src/cli/commands/doctor_datastores.ts: createDoctorDatastoresDeps: YamlVaultConfigRepository",
  "src/cli/commands/model_method_run.ts: modelMethodRunCommand: YamlDefinitionRepository",
  "src/cli/commands/serve.ts: serveCommand: YamlDefinitionRepository",
  "src/cli/commands/serve.ts: serveCommand: YamlVaultConfigRepository",
  "src/cli/commands/workflow_approvals.ts: workflowApprovalsCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_cancel.ts: workflowCancelCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_resume.ts: workflowResumeCommand: YamlDefinitionRepository",
  "src/cli/commands/workflow_resume.ts: workflowResumeCommand: YamlEvaluatedWorkflowRepository",
  "src/cli/commands/workflow_run.ts: workflowRunCommand: YamlDefinitionRepository",
  "src/cli/commands/workflow_run.ts: workflowRunCommand: YamlEvaluatedWorkflowRepository",
  // Built directly in src/cli/completion_types.ts.
  "src/cli/completion_types.ts: ModelNameType: YamlDefinitionRepository",
  "src/cli/completion_types.ts: WorkflowNameType: YamlWorkflowRepository",
  // Built directly in src/cli/datastore_expression_resolver.ts.
  "src/cli/datastore_expression_resolver.ts: createEarlyVaultService: YamlVaultConfigRepository",
  // Built directly in src/cli/mod.ts.
  "src/cli/mod.ts: configureExtensionAutoResolver: LockfileRepository",
  "src/cli/mod.ts: configureStartupExtensions: LockfileRepository",
  "src/cli/mod.ts: initTelemetryService: YamlVaultConfigRepository",
  // Built directly in src/domain/vaults/.
  "src/domain/vaults/vault_service.ts: VaultService: JsonlVaultAuditRepository",
  "src/domain/vaults/vault_service.ts: VaultService: YamlVaultConfigRepository",
  // Built directly in src/domain/workflows/.
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
  // Built directly in src/infrastructure/persistence/.
  "src/infrastructure/persistence/ephemeral_store.ts: wrapWithEphemeral: CompositeUnifiedDataRepository",
  // Built directly in src/libswamp/access/.
  "src/libswamp/access/run_deps.ts: createServerTokenRunDeps: YamlDefinitionRepository",
  // Built directly in src/libswamp/audit/.
  "src/libswamp/audit/timeline.ts: createAuditTimelineDeps: JsonlAuditRepository",
  // Built directly in src/libswamp/data/.
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
  "src/libswamp/data/run_gc.ts: createRunGcDeps: YamlEvaluatedWorkflowRepository",
  "src/libswamp/data/run_gc.ts: createRunGcDeps: YamlOutputRepository",
  "src/libswamp/data/run_gc.ts: createRunGcDeps: YamlWorkflowRunRepository",
  "src/libswamp/data/versions.ts: createDataVersionsDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/versions.ts: createDataVersionsDeps: YamlDefinitionRepository",
  // Built directly in src/libswamp/extensions/.
  "src/libswamp/extensions/list.ts: createExtensionListDeps: LockfileRepository",
  "src/libswamp/extensions/managed_lockfile_transaction.ts: ManagedLockfileTransaction: LockfileRepository",
  // Built directly in src/libswamp/models/.
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
  "src/libswamp/models/get.ts: createModelGetDeps: YamlDefinitionRepository",
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
  // Built directly in src/libswamp/reports/.
  "src/libswamp/reports/search.ts: createReportSearchDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: YamlDefinitionRepository",
  "src/libswamp/reports/search.ts: createReportSearchDeps: YamlWorkflowRepository",
  // Built directly in src/libswamp/vaults/.
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
  // Built directly in src/libswamp/worker/.
  "src/libswamp/worker/run_deps.ts: createWorkerModelRunDeps: YamlDefinitionRepository",
  // Built directly in src/libswamp/workflows/.
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
  // Built directly in src/serve/.
  "src/serve/deps.ts: createModelMethodRunDeps: YamlDefinitionRepository",
  "src/serve/deps.ts: createWorkflowRunDeps: YamlDefinitionRepository",
  "src/serve/deps.ts: createWorkflowRunDeps: YamlEvaluatedWorkflowRepository",
  "src/serve/device_auth_handler.ts: mintServerTokenImpl: YamlDefinitionRepository",
  "src/serve/handlers/access_handlers.ts: handleAccessReload: YamlDefinitionRepository",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowApprovals: YamlEvaluatedWorkflowRepository",
  "src/serve/server_token_gc_deps.ts: createServerTokenGcRepos: YamlDefinitionRepository",
  "src/serve/suspended_run_cancel.ts: cancelSuspendedRunAndPush: YamlEvaluatedWorkflowRepository",
];

const PINNED_UNHOOKED_WRITERS: readonly string[] = [
  // Read only: these repositories never write.
  "src/cli/commands/workflow_approvals.ts: workflowApprovalsCommand: YamlEvaluatedWorkflowRepository",
  // Read a run's evaluated snapshot to settle a cancelled run against it.
  "src/cli/commands/workflow_cancel.ts: workflowCancelCommand: YamlEvaluatedWorkflowRepository",
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
  "src/libswamp/models/get.ts: createModelGetDeps: YamlDefinitionRepository",
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
  // Read a run's evaluated snapshot to settle a cancelled run against it.
  "src/serve/deps.ts: createWorkflowRunDeps: YamlEvaluatedWorkflowRepository",
  "src/serve/suspended_run_cancel.ts: cancelSuspendedRunAndPush: YamlEvaluatedWorkflowRepository",
  // Factory helpers with no callers.
  "src/infrastructure/persistence/repository_factory.ts: createDefinitionRepository: YamlDefinitionRepository",
  "src/infrastructure/persistence/repository_factory.ts: createWorkflowRepository: YamlWorkflowRepository",
  // Fallback only: every CLI and serve caller injects the hooked repoContext repository.
  "src/libswamp/data/delete.ts: createDataDeleteDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/prune.ts: createDataPruneDeps: FileSystemUnifiedDataRepository",
  "src/libswamp/data/rename.ts: createDataRenameDeps: FileSystemUnifiedDataRepository",
  // The CLI writes through these, then pushManagedConfigChanges sends a bare mark
  // (managedConfig only); serve injects the hooked repository.
  "src/libswamp/models/create.ts: createModelCreateDeps: YamlDefinitionRepository",
  "src/libswamp/models/edit.ts: createModelEditDeps: YamlDefinitionRepository",
  "src/libswamp/workflows/create.ts: createWorkflowCreateDeps: YamlWorkflowRepository",
  // GAP: evaluated definitions and workflows are written to the datastore tier and
  // nothing marks them; serve never pushes after evaluate. Left for datastore
  // refactor phase 2.
  "src/libswamp/models/evaluate.ts: createModelEvaluateDeps: YamlEvaluatedDefinitionRepository",
  "src/libswamp/workflows/evaluate.ts: createWorkflowEvaluateDeps: YamlEvaluatedWorkflowRepository",
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
