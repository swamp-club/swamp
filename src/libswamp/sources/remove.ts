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
import { notFound, validationFailed } from "../errors.ts";
import type { SourceModifyEvent } from "./source_events.ts";
import type { SwampSourcesConfig } from "../../domain/repo/swamp_sources.ts";
import {
  readSwampSources,
  removeSwampSources,
  writeSwampSources,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";

/** Dependencies for the source remove operation. */
export interface SourceRemoveDeps {
  readSources: () => Promise<SwampSourcesConfig | null>;
  writeSources: (config: SwampSourcesConfig) => Promise<void>;
  removeSources: () => Promise<void>;
}

/** Wires real infrastructure into SourceRemoveDeps. */
export function createSourceRemoveDeps(repoDir: string): SourceRemoveDeps {
  return {
    readSources: () => readSwampSources(repoDir),
    writeSources: (config) => writeSwampSources(repoDir, config),
    removeSources: () => removeSwampSources(repoDir),
  };
}

/** Removes a source path from `.swamp-sources.yaml`. */
export async function* sourceRemove(
  _ctx: LibSwampContext,
  deps: SourceRemoveDeps,
  path: string,
): AsyncIterable<SourceModifyEvent> {
  yield { kind: "resolving" };

  const existing = await deps.readSources();
  if (!existing || existing.sources.length === 0) {
    yield {
      kind: "error",
      error: validationFailed(
        "No extension sources configured. Nothing to remove.",
      ),
    };
    return;
  }

  const idx = existing.sources.findIndex((s) => s.path === path);
  if (idx === -1) {
    yield {
      kind: "error",
      error: notFound("Extension source", path),
    };
    return;
  }

  const removed = existing.sources[idx];
  const updated = existing.sources.filter((_, i) => i !== idx);

  if (updated.length === 0) {
    // Last source removed — delete the file entirely
    await deps.removeSources();
  } else {
    await deps.writeSources({ sources: updated });
  }

  yield {
    kind: "completed",
    data: {
      action: "removed",
      path,
      only: removed.only,
      totalSources: updated.length,
    },
  };
}
