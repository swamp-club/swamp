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
 * order: SWAMP_MODELS_DIR, SWAMP_BEHAVIORS_DIR, .swamp.yaml, then
 * extensions/models; an empty variable counts as unset
 */
export function resolveModelsDir(marker: RepoMarkerData | null): string {
  const envModelsDir = Deno.env.get(MODELS_DIR_ENV_VAR) ||
    Deno.env.get(BEHAVIORS_DIR_ENV_VAR);
  if (envModelsDir) {
    return envModelsDir;
  }

  if (marker?.modelsDir) {
    return marker.modelsDir;
  }

  return DEFAULT_MODELS_DIR;
}

/**
 * undefined once the models directory is moved, so a repo that configured where
 * its models live never gains a second, unconfigured directory
 */
export function resolveBehaviorsDir(
  marker: RepoMarkerData | null,
): string | undefined {
  return resolveModelsDir(marker) === DEFAULT_MODELS_DIR
    ? DEFAULT_BEHAVIORS_DIR
    : undefined;
}

/** a symlinked behaviors directory counts, as a symlinked models directory does */
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
 * resolveModelsDir never refuses, preferring SWAMP_MODELS_DIR, because some
 * callers swallow its errors; the CLI checks this once at startup instead
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
