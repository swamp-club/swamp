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

import { join, resolve } from "@std/path";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** A single extension entry for list output. */
export interface ExtensionListEntry {
  name: string;
  version: string;
  pulledAt: string;
  files: string[];
  channel?: string;
}

/** Data payload for the completed event. */
export interface ExtensionListData {
  extensions: ExtensionListEntry[];
}

export type ExtensionListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionListData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the extension list operation. */
export interface ExtensionListDeps {
  /**
   * Lockfile repository pre-constructed by the caller. Captures a
   * snapshot of upstream_extensions.json at construction.
   */
  lockfileRepository: LockfileRepository;
}

/** Wires real infrastructure into ExtensionListDeps. */
export async function createExtensionListDeps(
  repoDir: string,
): Promise<ExtensionListDeps> {
  const repoPath = RepoPath.create(repoDir);
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);
  const envModelsDir = Deno.env.get("SWAMP_MODELS_DIR");
  const modelsDir = envModelsDir ?? marker?.modelsDir ?? "extensions/models";
  const absoluteModelsDir = resolve(repoDir, modelsDir);
  const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");
  return {
    lockfileRepository: await LockfileRepository.create(lockfilePath),
  };
}

/** Yields the list of installed upstream extensions. */
export async function* extensionList(
  _ctx: LibSwampContext,
  deps: ExtensionListDeps,
): AsyncIterable<ExtensionListEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.list",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const upstreamData = deps.lockfileRepository.getAllEntries();

      const entries: ExtensionListEntry[] = Object.entries(upstreamData)
        .map(([name, entry]) => ({
          name,
          version: entry.version,
          pulledAt: entry.pulledAt ?? "",
          files: entry.files ?? [],
          ...(entry.channel ? { channel: entry.channel } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      yield { kind: "completed", data: { extensions: entries } };
    })(),
  );
}
