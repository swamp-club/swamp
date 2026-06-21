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
import {
  copySourceSkills,
  removeSourceSkills,
  type ResolvedSkill,
  resolveSourceSkills,
} from "./source_skills.ts";

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
  /** Resolves skill directories from a source extension's manifest. */
  resolveSkills: (sourcePath: string) => Promise<ResolvedSkill[]>;
  /** Copies resolved skills to the repo's skill directory. */
  copySkills: (skills: ResolvedSkill[]) => Promise<string[]>;
  /** Removes named skill directories (used for cleanup on partial failure). */
  cleanupSkills: (skillNames: string[]) => Promise<void>;
}

/** Wires real infrastructure into SourceAddDeps. */
export function createSourceAddDeps(
  repoDir: string,
  tools?: string[],
  skillsDir?: string,
): SourceAddDeps {
  const resolvedTools = tools?.length ? tools : ["claude"];
  return {
    readSources: () => readSwampSources(repoDir),
    writeSources: (config) => writeSwampSources(repoDir, config),
    resolveKinds: (source) => resolveExtensionKindsForSource(source, repoDir),
    expandSource: (source) => expandSourcePaths({ sources: [source] }, repoDir),
    resolveSkills: (sourcePath) =>
      resolveSourceSkills(sourcePath, resolvedTools),
    copySkills: (skills) =>
      skillsDir ? copySourceSkills(skills, skillsDir) : Promise.resolve([]),
    cleanupSkills: (skillNames) =>
      skillsDir ? removeSourceSkills(skillNames, skillsDir) : Promise.resolve(),
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
  const isGlob = isGlobPattern(path);
  let cachedExpansions: SwampSource[] | undefined;
  const resolvedKinds = await deps.resolveKinds(tentative);
  if (resolvedKinds.length === 0) {
    if (isGlob) {
      cachedExpansions = await deps.expandSource(tentative);
      if (cachedExpansions.length > 0) {
        // Glob expanded to concrete dirs but none contributed kinds.
        yield {
          kind: "error",
          error: validationFailed(
            `No extensions found under glob '${path}'. ` +
              `All ${cachedExpansions.length} matched path(s) lack either ` +
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

  const newEntry: SwampSource = only ? { path, only } : { path };

  // Resolve and copy skills from the source's manifest.
  // For glob sources, reuse the cached expansion from validation.
  const sourcesToProbe = isGlob
    ? (cachedExpansions ?? await deps.expandSource(newEntry))
    : [newEntry];

  const allInstalledSkills: string[] = [];
  try {
    for (const source of sourcesToProbe) {
      const skills = await deps.resolveSkills(source.path);
      if (skills.length > 0) {
        const copied = await deps.copySkills(skills);
        allInstalledSkills.push(...copied);
      }
    }
  } catch (error) {
    if (allInstalledSkills.length > 0) {
      await deps.cleanupSkills(allInstalledSkills);
    }
    throw error;
  }

  if (allInstalledSkills.length > 0) {
    newEntry.installedSkills = allInstalledSkills;
  }

  const updated = [...sources, newEntry];
  await deps.writeSources({ sources: updated });

  yield {
    kind: "completed",
    data: {
      action: "added",
      path,
      only,
      totalSources: updated.length,
      ...(allInstalledSkills.length > 0
        ? { installedSkills: allInstalledSkills }
        : {}),
    },
  };
}
