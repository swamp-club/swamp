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

import type { ExtensionKind } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { RowState } from "./row_state.ts";
import type { SourceFingerprint } from "./source_fingerprint.ts";
import type { SourceLocation } from "./source_location.ts";

/**
 * fully immutable: every aggregate transition produces a new Source; the map is
 * keyed by SourceLocation so sourceLocationEquals flows through to lookups
 */
export interface Source {
  readonly id: SourceLocation;
  readonly kind: ExtensionKind;
  readonly fingerprint: SourceFingerprint;
  readonly state: RowState;
  readonly sourceMtime: string;
}

/**
 * there is no default-state Source: reach a state through the Extension
 * transition method first, not by constructing directly
 */
export function makeSource(args: {
  id: SourceLocation;
  kind: ExtensionKind;
  fingerprint: SourceFingerprint;
  state: RowState;
  sourceMtime: string;
}): Source {
  return {
    id: args.id,
    kind: args.kind,
    fingerprint: args.fingerprint,
    state: args.state,
    sourceMtime: args.sourceMtime,
  };
}

/** the caller must ensure the transition is valid per the RowState table */
export function withState(source: Source, state: RowState): Source {
  return makeSource({
    id: source.id,
    kind: source.kind,
    fingerprint: source.fingerprint,
    state,
    sourceMtime: source.sourceMtime,
  });
}

export function withFingerprintAndState(
  source: Source,
  fingerprint: SourceFingerprint,
  state: RowState,
  sourceMtime: string,
): Source {
  return makeSource({
    id: source.id,
    kind: source.kind,
    fingerprint,
    state,
    sourceMtime,
  });
}
