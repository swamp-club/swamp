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
//   staged changes (datastore-tier repository classes):
//     grep -nE 'kind: (.*\? )?"(write|remove|bulk)"' src/infrastructure/persistence/*_repository.ts
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

// ---------------------------------------------------------------------------
// Rule 4: unit-of-work scopes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rule 5: typed changes repositories stage
// ---------------------------------------------------------------------------

// The kind property of a StagedChange literal: a literal kind, or a ternary
// between two literal kinds, keyed "write|remove" (a delete that stages a
// write when it keeps the file, swamp-club#2980). Matched on its own, so a
// call that deno fmt wraps over several lines still counts once. Any other
// kind expression does not match, so the change goes missing from the pin.
const STAGED_KIND =
  /\bkind:\s*(?:"(write|remove|bulk)"|[^,}\n?"]+\?\s*"(write|remove|bulk)"\s*:\s*"(write|remove|bulk)")/g;

/**
 * One key per staged change inside a datastore-tier repository class, as
 * "<file>: <class> <kind>". Scoped to those classes, so the StagedChange type
 * union and the legacy adapter never count.
 */
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

// ---------------------------------------------------------------------------
// Rule 6: mark calls in the persistence layer
// ---------------------------------------------------------------------------

const PERSISTENCE_DIR = "src/infrastructure/persistence/";

/**
 * The only persistence files that may call a mark hook, each with its reason
 * (datastore rework Phase 1 close-out, swamp-club#2996). Repositories stage
 * through signalChange instead. A Phase 3 adapter that forwards staged
 * changes is added here on purpose.
 */
const PERSISTENCE_MARK_ADAPTERS: Record<string, string> = {
  "src/infrastructure/persistence/legacy_unit_of_work.ts":
    "the legacy unit of work forwards each staged change to the mark hook",
  "src/infrastructure/persistence/unit_of_work_scope.ts":
    "signalChange calls the hook directly when no scope is bound to it",
};

/** Mark call sites under the persistence layer outside the allowed adapters. */
function persistenceMarksOutsideAdapters(
  files: readonly SourceFile[],
): string[] {
  return markCallSites(files).filter((key) => {
    const rel = key.slice(0, key.indexOf(": "));
    return rel.startsWith(PERSISTENCE_DIR) &&
      !Object.hasOwn(PERSISTENCE_MARK_ADAPTERS, rel);
  });
}

// ---------------------------------------------------------------------------
// Rule 7: repositories reach their hook only through signalChange
// ---------------------------------------------------------------------------

// A reference to a repository's hook field. The field is markDirty or
// markDirtyHook depending on the class.
const HOOK_FIELD = /\bthis\.(?:markDirty|markDirtyHook)\b/g;
// How far before a hook reference to look for `signalChange(`: enough for
// the call name plus the newline and indentation deno fmt adds when it wraps
// the arguments. A longer gap reports a false violation, never misses one.
const SIGNAL_CHANGE_LOOKBACK = 200;

/**
 * One key per reference to the hook field inside a datastore-tier repository
 * class that is not the first argument of a `signalChange(...)` call, as
 * "<file>: <class>": calling the hook, passing it elsewhere, or storing it.
 * Code before and after the reference is read across lines, so a call that
 * deno fmt wraps still counts as signalChange's argument. The constructor
 * parameter (`private readonly markDirty?: MarkDirtyHook`) is not a
 * `this.` reference and never counts.
 *
 * Known limits: only classes in DATASTORE_TIER_REPOSITORIES are scanned, so a
 * new hooked repository must be added there (rule 6 still catches a direct
 * hook call anywhere under the persistence layer). As a textual scan it
 * cannot see the hook reached by aliasing, such as destructuring it off
 * `this`, or by bracket access such as `this["markDirty"]`.
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
          if (/\bsignalChange\(\s*$/.test(before) && /^\s*,/.test(after)) {
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
  // The one routing helper the repositories stage their changes through:
  // it stages into an ambient unit of work bound to the hook, or calls the
  // hook (swamp-club#2971). Exactly one call.
  "src/infrastructure/persistence/unit_of_work_scope.ts: signalChange",
  // Use cases that mark directly.
  "src/libswamp/datastores/namespace_migrate.ts: datastoreNamespaceMigrate",
  "src/libswamp/extensions/managed_lockfile_transaction.ts: createDatastoreLockfileSync",
  // Serve handlers marking written paths before pushChanged.
  "src/serve/device_auth_handler.ts: mintServerTokenImpl (x2)",
  "src/serve/grant_write_tracking.ts: publishGrantWrites",
  "src/serve/handlers/access_handlers.ts: handleAccessReload",
  "src/serve/handlers/admin_handlers.ts: extensionLockfileTransaction",
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
  // Vault configs (swamp-club#2995). Read only: these never save or delete a
  // vault config.
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
  // The CLI writes vault configs through these, then pushManagedConfigChanges
  // sends a bare mark (managedConfig only); serve injects the hooked
  // repository.
  "src/libswamp/vaults/create.ts: createVaultCreateDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/edit.ts: createVaultEditDeps: YamlVaultConfigRepository",
  "src/libswamp/vaults/migrate.ts: createVaultMigrateDeps: YamlVaultConfigRepository",
];

// Typed changes the moved repositories stage before each write or remove
// (datastore rework Phase 1 repository moves). A write names a path that
// exists after the operation, a remove one that is gone after it;
// integration/repository_dirty_coverage_test.ts checks that against the disk.
const PINNED_STAGED_CHANGES: readonly string[] = [
  // swamp-club#2979, move A.
  "src/infrastructure/persistence/unified_data_repository.ts: FileSystemUnifiedDataRepository remove (x7)",
  "src/infrastructure/persistence/unified_data_repository.ts: FileSystemUnifiedDataRepository write (x8)",
  "src/infrastructure/persistence/yaml_output_repository.ts: YamlOutputRepository remove (x3)",
  "src/infrastructure/persistence/yaml_output_repository.ts: YamlOutputRepository write",
  // swamp-club#2980, move B. "write|remove" is a delete whose resolved path
  // is kept when it holds another definition or workflow sharing the id.
  "src/infrastructure/persistence/yaml_definition_repository.ts: YamlDefinitionRepository remove",
  "src/infrastructure/persistence/yaml_definition_repository.ts: YamlDefinitionRepository write",
  "src/infrastructure/persistence/yaml_definition_repository.ts: YamlDefinitionRepository write|remove",
  "src/infrastructure/persistence/yaml_evaluated_definition_repository.ts: YamlEvaluatedDefinitionRepository remove (x2)",
  "src/infrastructure/persistence/yaml_evaluated_definition_repository.ts: YamlEvaluatedDefinitionRepository write",
  "src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts: YamlEvaluatedWorkflowRepository remove (x3)",
  "src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts: YamlEvaluatedWorkflowRepository write (x2)",
  "src/infrastructure/persistence/yaml_workflow_repository.ts: YamlWorkflowRepository write",
  "src/infrastructure/persistence/yaml_workflow_repository.ts: YamlWorkflowRepository write|remove",
  // swamp-club#2992, move C1.
  "src/infrastructure/persistence/yaml_workflow_run_repository.ts: YamlWorkflowRunRepository remove (x3)",
  "src/infrastructure/persistence/yaml_workflow_run_repository.ts: YamlWorkflowRunRepository write",
  // swamp-club#2995, move C2.
  "src/infrastructure/persistence/yaml_vault_config_repository.ts: YamlVaultConfigRepository remove",
  "src/infrastructure/persistence/yaml_vault_config_repository.ts: YamlVaultConfigRepository write",
];

// Production code that opens an ambient unit of work. Empty in datastore
// rework Phase 1 (swamp-club#2971): repositories can stage into a scope, but
// nothing opens one, so behaviour is unchanged by construction. Phase 2 adds
// use cases here on purpose.
const PINNED_UNIT_OF_WORK_SCOPES: readonly string[] = [];

// Hook references in datastore-tier repositories other than signalChange's
// first argument. Empty since the datastore rework Phase 1 repository moves
// (swamp-club#2996): repositories never call, pass on or store their hook.
const PINNED_HOOK_MISUSES: readonly string[] = [];

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
    "Phase 1 keeps the ambient unit of work inert: no production code opens\n" +
      "a scope yet. Opening one is datastore rework Phase 2; if this is that\n" +
      "work, add the caller here with a reason.",
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

Deno.test("datastore write seams: repositories reference their hook only as signalChange's first argument (swamp-club#2996)", () => {
  assertPinnedSet(
    hookReferencesOutsideSignalChange(files),
    PINNED_HOOK_MISUSES,
    "Datastore-tier repository hook references outside signalChange",
    "A repository reaches its mark hook only as the first argument of\n" +
      "signalChange(this.<hook>, change), so the unit of work sees every change.\n" +
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
