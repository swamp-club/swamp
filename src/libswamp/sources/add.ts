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
import type { ExtensionKind } from "../../domain/repo/swamp_sources.ts";
import type { SwampSourcesConfig } from "../../domain/repo/swamp_sources.ts";
import {
  readSwampSources,
  writeSwampSources,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";

/** Dependencies for the source add operation. */
export interface SourceAddDeps {
  readSources: () => Promise<SwampSourcesConfig | null>;
  writeSources: (config: SwampSourcesConfig) => Promise<void>;
}

/** Wires real infrastructure into SourceAddDeps. */
export function createSourceAddDeps(repoDir: string): SourceAddDeps {
  return {
    readSources: () => readSwampSources(repoDir),
    writeSources: (config) => writeSwampSources(repoDir, config),
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
