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

import {
  type Extension,
  makeExtension,
  recordBundleBuildFailed,
  recordValidationFailed,
} from "./extension.ts";
import type { ExtensionKind } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { makeBundleLocation } from "./bundle_location.ts";
import type { RowStateTag } from "./row_state.ts";
import { makeSource } from "./source.ts";
import type { Source } from "./source.ts";
import type { SourceLocation } from "./source_location.ts";
import { ValidationError } from "./validation_error.ts";

export type KindDir =
  | "models"
  | "vaults"
  | "drivers"
  | "datastores"
  | "reports";

export interface SourceFailureTransition {
  readonly source: SourceLocation;
  readonly fromState: RowStateTag | null;
  readonly toState: RowStateTag;
  readonly reason: string;
}

export interface RecordSourceFailureArgs {
  readonly extension: Extension;
  readonly location: SourceLocation;
  readonly kindDir: KindDir;
  readonly error: unknown;
  readonly existingSource: Source | undefined;
  readonly fingerprint: string;
  readonly sourceMtime: string;
}

export interface RecordSourceFailureResult {
  readonly extension: Extension;
  readonly transition: SourceFailureTransition | undefined;
}

export function recordSourceFailure(
  args: RecordSourceFailureArgs,
): RecordSourceFailureResult {
  const {
    location,
    kindDir,
    error,
    existingSource,
    fingerprint,
    sourceMtime,
  } = args;
  let ext = args.extension;

  const fromState = existingSource?.state.tag ?? null;
  const errorMsg = error instanceof Error ? error.message : String(error);
  const isValidation = error instanceof ValidationError;
  const toState: RowStateTag = isValidation
    ? "ValidationFailed"
    : "BundleBuildFailed";

  if (isValidation) {
    const bundle = makeBundleLocation(error.bundlePath, error.fingerprint);
    if (existingSource) {
      ext = recordValidationFailed(ext, {
        location,
        bundle,
        lastError: errorMsg,
        fingerprint,
        sourceMtime,
      });
    } else {
      ext = makeExtensionWithNewSource(
        ext,
        location,
        kindDir,
        { tag: "ValidationFailed", bundle, lastError: errorMsg },
        sourceMtime,
        fingerprint,
      );
    }
  } else {
    if (existingSource) {
      ext = recordBundleBuildFailed(ext, {
        location,
        lastError: errorMsg,
        fingerprint,
        sourceMtime,
      });
    } else {
      ext = makeExtensionWithNewSource(
        ext,
        location,
        kindDir,
        { tag: "BundleBuildFailed", lastError: errorMsg },
        sourceMtime,
        fingerprint,
      );
    }
  }

  const transition: SourceFailureTransition | undefined = fromState !== toState
    ? {
      source: location,
      fromState,
      toState,
      reason: isValidation
        ? `validation failed: ${errorMsg}`
        : `bundle build failed: ${errorMsg}`,
    }
    : undefined;

  return { extension: ext, transition };
}

export function findSourceByPath(
  extension: Extension,
  canonicalPath: string,
): Source | undefined {
  for (const [loc, source] of extension.sources) {
    if (loc.canonicalPath === canonicalPath) return source;
  }
  return undefined;
}

export function kindDirToExtensionKind(
  kindDir: KindDir,
): ExtensionKind {
  switch (kindDir) {
    case "models":
      return "model";
    case "vaults":
      return "vault";
    case "drivers":
      return "driver";
    case "datastores":
      return "datastore";
    case "reports":
      return "report";
  }
}

export function extensionKindToKindDir(
  kind: ExtensionKind,
): KindDir {
  switch (kind) {
    case "model":
    case "extension":
      return "models";
    case "vault":
      return "vaults";
    case "driver":
      return "drivers";
    case "datastore":
      return "datastores";
    case "report":
      return "reports";
  }
}

function makeExtensionWithNewSource(
  extension: Extension,
  location: SourceLocation,
  kindDir: KindDir,
  state:
    | { tag: "BundleBuildFailed"; lastError: string }
    | {
      tag: "ValidationFailed";
      bundle: ReturnType<typeof makeBundleLocation>;
      lastError: string;
    },
  sourceMtime: string,
  fingerprint = "",
): Extension {
  const kind = kindDirToExtensionKind(kindDir);
  const source = makeSource({
    id: location,
    kind,
    fingerprint,
    state,
    sourceMtime,
  });
  return makeExtension({
    ...extension,
    sources: [...extension.sources.values(), source],
  });
}
