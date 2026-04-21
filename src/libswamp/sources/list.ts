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
import type { SourceListEntry, SourceListEvent } from "./source_events.ts";
import { isGlobPattern } from "../../domain/repo/swamp_sources.ts";
import type {
  ExtensionKind,
  SwampSource,
  SwampSourcesConfig,
} from "../../domain/repo/swamp_sources.ts";
import {
  expandSourcePaths,
  readSwampSources,
  resolveExtensionKindsForSource,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";
import { expandEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { isAbsolute, resolve } from "@std/path";

/** Dependencies for the source list operation. */
export interface SourceListDeps {
  readSources: () => Promise<SwampSourcesConfig | null>;
  repoDir: string;
  /** Returns the kinds a source contributes. Injectable for unit tests. */
  resolveKinds: (source: SwampSource) => Promise<ExtensionKind[]>;
}

/** Wires real infrastructure into SourceListDeps. */
export function createSourceListDeps(repoDir: string): SourceListDeps {
  return {
    readSources: () => readSwampSources(repoDir),
    repoDir,
    resolveKinds: (source) => resolveExtensionKindsForSource(source, repoDir),
  };
}

/** Lists all configured extension sources with their status. */
export async function* sourceList(
  _ctx: LibSwampContext,
  deps: SourceListDeps,
): AsyncIterable<SourceListEvent> {
  yield { kind: "resolving" };

  const config = await deps.readSources();
  if (!config || config.sources.length === 0) {
    yield {
      kind: "completed",
      data: { sources: [] },
    };
    return;
  }

  const entries: SourceListEntry[] = [];

  for (const source of config.sources) {
    const entry: SourceListEntry = {
      path: source.path,
      only: source.only,
      expandedPaths: [],
      status: "valid",
    };

    try {
      if (isGlobPattern(source.path)) {
        const expanded = await expandSourcePaths(
          { sources: [source] },
          deps.repoDir,
        );
        entry.expandedPaths = expanded.map((s) => s.path);
        if (expanded.length === 0) {
          // Unexpanded glob — path(s) not yet present on disk.
          entry.status = "path_not_found";
        } else {
          const kinds = await deps.resolveKinds(source);
          if (kinds.length === 0) {
            entry.status = "no_extensions";
          } else {
            entry.resolvedKinds = kinds;
          }
        }
      } else {
        const expandedPath = expandEnvVars(source.path);
        const absolutePath = isAbsolute(expandedPath)
          ? expandedPath
          : resolve(deps.repoDir, expandedPath);
        entry.expandedPaths = [absolutePath];

        let exists = false;
        try {
          const stat = await Deno.stat(absolutePath);
          exists = stat.isDirectory;
        } catch {
          exists = false;
        }

        if (!exists) {
          entry.status = "path_not_found";
        } else {
          const kinds = await deps.resolveKinds(source);
          if (kinds.length === 0) {
            entry.status = "no_extensions";
          } else {
            entry.resolvedKinds = kinds;
          }
        }
      }
    } catch {
      // Expansion or resolver threw (e.g., unset env var, unreadable
      // marker) — surface the source but mark it missing so the user
      // sees something went wrong without aborting the rest of the list.
      entry.status = "path_not_found";
    }

    entries.push(entry);
  }

  yield {
    kind: "completed",
    data: { sources: entries },
  };
}
