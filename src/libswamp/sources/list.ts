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
import type { SwampSourcesConfig } from "../../domain/repo/swamp_sources.ts";
import {
  expandSourcePaths,
  readSwampSources,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";
import { expandEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { isAbsolute, resolve } from "@std/path";

/** Dependencies for the source list operation. */
export interface SourceListDeps {
  readSources: () => Promise<SwampSourcesConfig | null>;
  repoDir: string;
}

/** Wires real infrastructure into SourceListDeps. */
export function createSourceListDeps(repoDir: string): SourceListDeps {
  return {
    readSources: () => readSwampSources(repoDir),
    repoDir,
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
        // Expand glob to get actual directories
        const expanded = await expandSourcePaths(
          { sources: [source] },
          deps.repoDir,
        );
        entry.expandedPaths = expanded.map((s) => s.path);
        if (expanded.length === 0) {
          entry.status = "no_extensions";
        }
      } else {
        // Single path — check if it exists
        const expandedPath = expandEnvVars(source.path);
        const absolutePath = isAbsolute(expandedPath)
          ? expandedPath
          : resolve(deps.repoDir, expandedPath);
        entry.expandedPaths = [absolutePath];

        try {
          const stat = await Deno.stat(absolutePath);
          if (!stat.isDirectory) {
            entry.status = "path_not_found";
          }
        } catch {
          entry.status = "path_not_found";
        }
      }
    } catch {
      // Expansion failed (e.g., unset env var in path) — mark as not found
      // and continue listing remaining sources rather than aborting.
      entry.status = "path_not_found";
    }

    entries.push(entry);
  }

  yield {
    kind: "completed",
    data: { sources: entries },
  };
}
