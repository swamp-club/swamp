// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { LibSwampContext } from "../context.ts";
import { alreadyExists, validationFailed } from "../errors.ts";
import type { SourceModifyEvent } from "./source_events.ts";
import {
  EXTENSION_KINDS,
  type ExtensionKind,
  isGlobPattern,
  type SwampSource,
  type SwampSourcesConfig,
} from "../../domain/repo/swamp_sources.ts";
import {
  expandSourcePaths,
  readSwampSources,
  resolveExtensionKindsForSource,
  writeSwampSources,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";

/** Dependencies for the source add operation. */
export interface SourceAddDeps {
  readSources: () => Promise<SwampSourcesConfig | null>;
  writeSources: (config: SwampSourcesConfig) => Promise<void>;
  /** Returns the kinds a given source contributes. Injected so tests can
   * fake the resolver without touching the real filesystem. */
  resolveKinds: (source: SwampSource) => Promise<ExtensionKind[]>;
  /** Expands globs to concrete paths. Injected alongside resolveKinds so
   * the glob-vs-concrete validation split is fully testable. */
  expandSource: (source: SwampSource) => Promise<SwampSource[]>;
}

/** Wires real infrastructure into SourceAddDeps. */
export function createSourceAddDeps(repoDir: string): SourceAddDeps {
  return {
    readSources: () => readSwampSources(repoDir),
    writeSources: (config) => writeSwampSources(repoDir, config),
    resolveKinds: (source) => resolveExtensionKindsForSource(source, repoDir),
    expandSource: (source) => expandSourcePaths({ sources: [source] }, repoDir),
  };
}

/** Adds a source path to `.swamp-sources.yaml`. */
export async function* sourceAdd(
  _ctx: LibSwampContext,
  deps: SourceAddDeps,
  path: string,
  only?: ExtensionKind[],
): AsyncIterable<SourceModifyEvent> {
  yield { kind: "resolving" };

  if (!path || path.trim() === "") {
    yield {
      kind: "error",
      error: validationFailed("Source path must not be empty."),
    };
    return;
  }

  const existing = await deps.readSources();
  const sources = existing?.sources ?? [];

  // Check for duplicate path
  if (sources.some((s) => s.path === path)) {
    yield {
      kind: "error",
      error: alreadyExists("Extension source", path),
    };
    return;
  }

  // Validate that the source actually contributes extensions. Concrete
  // paths must resolve to ≥1 kind; unexpanded globs are allowed so users
  // can configure sources before the target dirs exist (pre-population).
  const tentative: SwampSource = only ? { path, only } : { path };
  const resolvedKinds = await deps.resolveKinds(tentative);
  if (resolvedKinds.length === 0) {
    const isGlob = isGlobPattern(path);
    if (isGlob) {
      const expansions = await deps.expandSource(tentative);
      if (expansions.length > 0) {
        // Glob expanded to concrete dirs but none contributed kinds.
        yield {
          kind: "error",
          error: validationFailed(
            `No extensions found under glob '${path}'. ` +
              `All ${expansions.length} matched path(s) lack either ` +
              `'extensions/<kind>/' subdirectories or files declaring ` +
              `extension exports (model, vault, driver, datastore, ` +
              `report, or workflow). Check the target paths or remove ` +
              `the source.`,
          ),
        };
        return;
      }
      // Unexpanded glob → allow (pre-population workflow).
    } else {
      const probed = only ?? EXTENSION_KINDS;
      yield {
        kind: "error",
        error: validationFailed(
          `No extensions found at '${path}'. ` +
            `Expected either 'extensions/<kind>/' subdirectories (where ` +
            `<kind> is one of ${probed.join(", ")}) OR files declaring ` +
            `extension exports (model, vault, driver, datastore, report) ` +
            `or workflow YAML directly in the path.`,
        ),
      };
      return;
    }
  }

  const newEntry = only ? { path, only } : { path };
  const updated = [...sources, newEntry];

  await deps.writeSources({ sources: updated });

  yield {
    kind: "completed",
    data: {
      action: "added",
      path,
      only,
      totalSources: updated.length,
    },
  };
}
