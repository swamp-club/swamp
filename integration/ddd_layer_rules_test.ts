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

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join } from "@std/path";
import {
  assertPinnedSet,
  collectImportEdges,
  extractImports,
  importsLayer,
  isUnder,
  repoRelative,
  resolveImport,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/**
 * Logging is a cross-cutting concern, not an infrastructure dependency.
 */
function isLoggingImport(filePath: string, importPath: string): boolean {
  return importsLayer(filePath, importPath, "infrastructure/logging");
}

/**
 * Tracing is a cross-cutting concern, not an infrastructure dependency.
 */
function isTracingImport(filePath: string, importPath: string): boolean {
  return importsLayer(filePath, importPath, "infrastructure/tracing");
}

/** A real (non-cross-cutting) import of the infrastructure layer. */
function importsInfrastructure(filePath: string, importPath: string): boolean {
  if (!importsLayer(filePath, importPath, "infrastructure")) return false;
  if (isLoggingImport(filePath, importPath)) return false;
  if (isTracingImport(filePath, importPath)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Domain → Infrastructure
// ---------------------------------------------------------------------------

// Pinned ratchet: the exact set of domain→infrastructure import edges that
// exist today. Not a count, and not per-file — per *edge*.
//
// The previous `KNOWN_DOMAIN_INFRA_VIOLATIONS = 26` guard counted offending
// files and `break`ed after the first bad import in each, so any file already
// on the list could grow unlimited additional infrastructure imports for free,
// and a fixed violation could be traded for a brand-new one without the count
// moving. Pinning every edge closes both holes.
//
// Policy: this list is legacy debt and must only ever shrink. The domain layer
// should depend on abstractions it owns (dependency inversion); concrete
// repositories, stores and evaluators belong behind a domain-owned port.
//
// Notable clusters:
//   - src/domain/extensions/* → canonicalize_path / extension_catalog_store
//     (#223, W1b): a pure cross-platform string transform the value objects
//     need at construction time, plus the ExtensionKind/ExtensionTypeRow
//     type-level discriminators the catalog defines. Accepted as transitional
//     ports; the canonicalizer should move to a shared path utility and
//     ExtensionKind should hoist into the domain when the catalog is replaced.
//   - src/domain/workflows/execution_service.ts and
//     src/domain/{data,expressions}/* → concrete YAML repositories, the CEL
//     evaluator and the catalog store: the pre-libswamp orchestration code
//     that never got its ports extracted.
const PINNED_DOMAIN_INFRA_EDGES: readonly string[] = [
  "src/domain/access/policy_snapshot_loader.ts -> src/infrastructure/cel/cel_evaluator.ts",
  "src/domain/data/composite_data_query_service.ts -> src/infrastructure/persistence/catalog_store.ts",
  "src/domain/data/data_query_service.ts -> src/infrastructure/cel/cel_evaluator.ts",
  "src/domain/data/data_query_service.ts -> src/infrastructure/persistence/catalog_store.ts",
  "src/domain/data/data_record_mapper.ts -> src/infrastructure/persistence/catalog_store.ts",
  "src/domain/data/workflow_data_service.ts -> src/infrastructure/persistence/yaml_definition_repository.ts",
  "src/domain/expressions/expression_evaluation_service.ts -> src/infrastructure/cel/cel_evaluator.ts",
  "src/domain/expressions/expression_evaluation_service.ts -> src/infrastructure/persistence/yaml_definition_repository.ts",
  "src/domain/expressions/model_resolver.ts -> src/infrastructure/persistence/yaml_definition_repository.ts",
  "src/domain/expressions/model_resolver.ts -> src/infrastructure/persistence/yaml_output_repository.ts",
  "src/domain/expressions/model_resolver.ts -> src/infrastructure/vaults/vault_refresh.ts",
  "src/domain/extensions/bundle_location.ts -> src/infrastructure/persistence/canonicalize_path.ts",
  "src/domain/extensions/datastore_kind_adapter.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/datastore_kind_adapter.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/extensions/extension.ts -> src/infrastructure/persistence/canonicalize_path.ts",
  "src/domain/extensions/extension.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/extension_loader.ts -> src/infrastructure/persistence/canonicalize_path.ts",
  "src/domain/extensions/extension_loader.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/extension_loader.ts -> src/infrastructure/persistence/extension_repository.ts",
  "src/domain/extensions/extension_loader.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/extensions/extension_loader.ts -> src/infrastructure/persistence/safe_path.ts",
  "src/domain/extensions/kind_adapter.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/model_kind_adapter.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/model_kind_adapter.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/extensions/report_kind_adapter.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/report_kind_adapter.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/extensions/source.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/source_failure_recorder.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/source_location.ts -> src/infrastructure/persistence/canonicalize_path.ts",
  "src/domain/extensions/vault_kind_adapter.ts -> src/infrastructure/persistence/extension_catalog_store.ts",
  "src/domain/extensions/vault_kind_adapter.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/models/access/grant_model.ts -> src/infrastructure/cel/grant_condition_environment.ts",
  "src/domain/models/command/shell/shell_model.ts -> src/infrastructure/process/process_executor.ts",
  "src/domain/repo/primary_tool.ts -> src/infrastructure/persistence/repo_marker_repository.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/assets/skill_assets.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/atomic_write.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/builtin_tool_skill_dirs_repository.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/custom_tool_skill_dirs_repository.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/custom_tools_repository.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/repo_marker_repository.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/telemetry_spool_migration.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/persistence/upstream_extensions.ts",
  "src/domain/repo/repo_service.ts -> src/infrastructure/process/resolve_command.ts",
  "src/domain/repo/skill_dirs.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/vaults/local_encryption_vault_provider.ts -> src/infrastructure/persistence/atomic_write.ts",
  "src/domain/vaults/local_encryption_vault_provider.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/vaults/local_encryption_vault_provider.ts -> src/infrastructure/persistence/safe_path.ts",
  "src/domain/vaults/local_encryption_vault_provider.ts -> src/infrastructure/security/file_security_check.ts",
  "src/domain/vaults/vault_service.ts -> src/infrastructure/persistence/jsonl_vault_audit_repository.ts",
  "src/domain/vaults/vault_service.ts -> src/infrastructure/persistence/yaml_vault_config_repository.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/cel/cel_evaluator.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/persistence/catalog_store.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/persistence/paths.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/persistence/unified_data_repository.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/persistence/yaml_definition_repository.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/persistence/yaml_evaluated_definition_repository.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/persistence/yaml_output_repository.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/stream/event_bridge.ts",
  "src/domain/workflows/execution_service.ts -> src/infrastructure/stream/merge.ts",
];

Deno.test(
  "collectImportEdges: domain→infrastructure imports match the pinned ratchet list",
  async () => {
    const edges = await collectImportEdges(
      join(SRC_DIR, "domain"),
      importsInfrastructure,
    );

    assertPinnedSet(
      edges,
      PINNED_DOMAIN_INFRA_EDGES,
      "Domain→Infrastructure imports",
      "The domain layer must not reach into infrastructure (dependency\n" +
        "inversion): define the port in the domain and implement it in\n" +
        "infrastructure instead. This list is frozen legacy debt — it may\n" +
        "shrink, never grow. Logging and tracing imports are exempt as\n" +
        "cross-cutting concerns.",
    );
  },
);

// ---------------------------------------------------------------------------
// Presentation → Infrastructure
// ---------------------------------------------------------------------------

Deno.test(
  "collectImportEdges: presentation layer must not import infrastructure (excluding logging)",
  async () => {
    const edges = await collectImportEdges(
      join(SRC_DIR, "presentation"),
      importsInfrastructure,
    );

    assertEquals(
      edges.length,
      0,
      `Presentation→Infrastructure violations found (excluding logging):\n` +
        `${edges.join("\n")}\n\n` +
        `The presentation layer should go through the CLI/application layer, not reach into infrastructure.\n` +
        `Logging and tracing imports are excluded as cross-cutting concerns.`,
    );
  },
);

// ---------------------------------------------------------------------------
// Serve → CLI
// ---------------------------------------------------------------------------

// Pinned ratchet: src/serve/ is a delivery mechanism that sits beside the CLI,
// not on top of it. Today it borrows a handful of CLI wiring helpers
// (repo_context, resolve_models_dir, dependency factories). Those edges are
// pinned as debt so no NEW ones can appear; the fix for each is to hoist the
// shared helper out of src/cli/ into a layer both delivery mechanisms can
// depend on.
const PINNED_SERVE_CLI_EDGES: readonly string[] = [
  "src/serve/connection.ts -> src/cli/commands/version.ts",
  "src/serve/deps.ts -> src/cli/repo_context.ts",
  "src/serve/extension_reload.ts -> src/cli/resolve_models_dir.ts",
  "src/serve/handlers/admin_handlers.ts -> src/cli/create_extension_install_deps.ts",
  "src/serve/handlers/admin_handlers.ts -> src/cli/load_identity.ts",
  "src/serve/handlers/admin_handlers.ts -> src/cli/resolve_datastore.ts",
  "src/serve/handlers/admin_handlers.ts -> src/cli/resolve_models_dir.ts",
  "src/serve/handlers/model_handlers.ts -> src/cli/repo_context.ts",
  "src/serve/handlers/vault_handlers.ts -> src/cli/repo_context.ts",
  "src/serve/handlers/workflow_handlers.ts -> src/cli/repo_context.ts",
  "src/serve/telemetry.ts -> src/cli/telemetry_integration.ts",
];

Deno.test(
  "collectImportEdges: serve→cli imports match the pinned ratchet list",
  async () => {
    const edges = await collectImportEdges(
      join(SRC_DIR, "serve"),
      (filePath, importPath) => importsLayer(filePath, importPath, "cli"),
    );

    assertPinnedSet(
      edges,
      PINNED_SERVE_CLI_EDGES,
      "Serve→CLI imports",
      "src/serve/ and src/cli/ are sibling delivery mechanisms — the server\n" +
        "must not depend on the CLI. Hoist the shared helper into a layer both\n" +
        "can depend on (src/libswamp/ or src/domain/) instead of adding a new\n" +
        "edge here. This list is frozen debt; it may shrink, never grow.",
    );
  },
);

// ---------------------------------------------------------------------------
// Presentation → CLI
// ---------------------------------------------------------------------------

// Pinned ratchet: renderers are pure output formatters. They must not reach
// back into the CLI/application layer — the CLI calls the renderer, never the
// other way round. Two of these are type-only `Verbosity` imports (the type
// belongs in the presentation layer); the third pulls a dispatcher.
const PINNED_PRESENTATION_CLI_EDGES: readonly string[] = [
  "src/presentation/renderers/datastore_namespace_list.ts -> src/cli/context.ts",
  "src/presentation/renderers/issue_create.ts -> src/cli/commands/extension_report_dispatcher.ts",
  "src/presentation/renderers/summarise.ts -> src/cli/context.ts",
];

Deno.test(
  "collectImportEdges: presentation→cli imports match the pinned ratchet list",
  async () => {
    const edges = await collectImportEdges(
      join(SRC_DIR, "presentation"),
      (filePath, importPath) => importsLayer(filePath, importPath, "cli"),
    );

    assertPinnedSet(
      edges,
      PINNED_PRESENTATION_CLI_EDGES,
      "Presentation→CLI imports",
      "Renderers are pure output formatters: the CLI calls presentation, not\n" +
        "the reverse. Pass what the renderer needs in as an argument, or move\n" +
        "the shared type into src/presentation/. This list is frozen debt; it\n" +
        "may shrink, never grow.",
    );
  },
);

// ---------------------------------------------------------------------------
// libswamp encapsulation
// ---------------------------------------------------------------------------

/**
 * libswamp's public surface is `src/libswamp/mod.ts`. CLI commands and
 * presentation renderers — including their tests — must import through the
 * barrel so libswamp internals stay free to move. See CLAUDE.md.
 *
 * This rule covers test files too: a test that reaches into an internal path
 * pins that path just as hard as production code does.
 */
Deno.test(
  "libswamp encapsulation: cli and presentation import libswamp only via mod.ts",
  async () => {
    const violations: string[] = [];

    for (const layer of ["cli", "presentation"]) {
      for await (
        const entry of walk(join(SRC_DIR, layer), {
          exts: [".ts", ".tsx"],
          includeDirs: false,
        })
      ) {
        const source = await Deno.readTextFile(entry.path);
        for (const importPath of extractImports(source)) {
          const resolved = resolveImport(entry.path, importPath);
          if (resolved === undefined) continue;
          if (!isUnder(resolved, "src/libswamp")) continue;
          if (resolved === "src/libswamp/mod.ts") continue;
          violations.push(`${repoRelative(entry.path)} -> ${resolved}`);
        }
      }
    }

    assertEquals(
      violations.length,
      0,
      `CLI/presentation code must import libswamp only via src/libswamp/mod.ts:\n` +
        `${violations.sort().join("\n")}\n\n` +
        `Deep imports into libswamp internals defeat the barrel: they pin\n` +
        `internal file layout and let callers bypass the curated public API.\n` +
        `Import the symbol from "src/libswamp/mod.ts" instead — and if it is\n` +
        `not re-exported there, export it from mod.ts first.`,
    );
  },
);

// ---------------------------------------------------------------------------
// legacyStore escape hatch
// ---------------------------------------------------------------------------

Deno.test(
  "legacyStore escape hatch must not be reintroduced (W4 CI guard)",
  async () => {
    const violations: string[] = [];

    for await (
      const entry of walk(SRC_DIR, {
        exts: [".ts", ".tsx"],
        includeDirs: false,
        skip: [/_test\.tsx?$/],
      })
    ) {
      const content = await Deno.readTextFile(entry.path);
      if (/\.legacyStore\b/.test(content)) {
        violations.push(repoRelative(entry.path));
      }
    }

    assertEquals(
      violations.length,
      0,
      `legacyStore references found (removed in W4):\n` +
        `${violations.sort().join("\n")}\n\n` +
        `Use typed ExtensionRepository methods instead.`,
    );
  },
);
