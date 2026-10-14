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

import { resolve } from "@std/path";
import type { RepoMarkerData } from "./repo_marker_repository.ts";
import {
  BEHAVIORS_DIR_ENV_VAR,
  DEFAULT_BEHAVIORS_DIR,
  DEFAULT_MODELS_DIR,
  MODELS_DIR_ENV_VAR,
} from "../../domain/terminology/behavior_aliases.ts";

/**
 * Resolves the models directory path.
 * Priority: SWAMP_MODELS_DIR env var > SWAMP_BEHAVIORS_DIR env var (its
 * behavior spelling, swamp-club#3410) > .swamp.yaml config > default
 * "extensions/models". An empty variable counts as unset.
 */
export function resolveModelsDir(marker: RepoMarkerData | null): string {
  // Environment variable takes highest priority
  const envModelsDir = Deno.env.get(MODELS_DIR_ENV_VAR) ||
    Deno.env.get(BEHAVIORS_DIR_ENV_VAR);
  if (envModelsDir) {
    return envModelsDir;
  }

  // Then .swamp.yaml config
  if (marker?.modelsDir) {
    return marker.modelsDir;
  }

  // Default
  return DEFAULT_MODELS_DIR;
}

/**
 * Resolves the behaviors directory, the behavior-spelled sibling of the
 * models directory (swamp-club#3338): `extensions/behaviors` while the
 * models directory is the default `extensions/models`, and undefined once
 * `SWAMP_MODELS_DIR`, `SWAMP_BEHAVIORS_DIR` or `.swamp.yaml` moves the
 * models directory, so a
 * repo that configured where its models live never gains a second,
 * unconfigured directory.
 */
export function resolveBehaviorsDir(
  marker: RepoMarkerData | null,
): string | undefined {
  return resolveModelsDir(marker) === DEFAULT_MODELS_DIR
    ? DEFAULT_BEHAVIORS_DIR
    : undefined;
}

/**
 * The absolute behaviors directory under `extBase` (swamp-club#3338), or
 * undefined when the models directory is configured or no behaviors
 * directory exists there. A symlinked directory counts, as a symlinked
 * models directory does.
 */
export async function existingBehaviorsDir(
  extBase: string,
  marker: RepoMarkerData | null,
): Promise<string | undefined> {
  const behaviorsDir = resolveBehaviorsDir(marker);
  if (behaviorsDir === undefined) return undefined;
  const absolute = resolve(extBase, behaviorsDir);
  try {
    return (await Deno.stat(absolute)).isDirectory ? absolute : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The startup refusal for a models directory named two ways
 * (swamp-club#3410): `SWAMP_MODELS_DIR` and `SWAMP_BEHAVIORS_DIR` both set,
 * to different non-empty values. Undefined when at most one is set or both
 * name the same directory. resolveModelsDir never refuses — it prefers
 * `SWAMP_MODELS_DIR` — because some callers swallow its errors; the CLI
 * checks this once at startup instead.
 */
export function modelsDirEnvConflict(): string | undefined {
  const modelsDir = Deno.env.get(MODELS_DIR_ENV_VAR);
  const behaviorsDir = Deno.env.get(BEHAVIORS_DIR_ENV_VAR);
  if (!modelsDir || !behaviorsDir || modelsDir === behaviorsDir) {
    return undefined;
  }
  return `${MODELS_DIR_ENV_VAR} (${modelsDir}) and ${BEHAVIORS_DIR_ENV_VAR} ` +
    `(${behaviorsDir}) name different directories. They are two spellings ` +
    `of the same setting; set one of them.`;
}
