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

import type { ExtensionKind } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { RowState } from "./row_state.ts";
import type { SourceFingerprint } from "./source_fingerprint.ts";
import type { SourceLocation } from "./source_location.ts";

/**
 * A single `.ts` entry point owned by an Extension aggregate.
 *
 * **Fully immutable.** Every aggregate transition produces a NEW Source
 * instance — no mutators here, no setters anywhere. Extension stores the
 * new instance in its sources map and the old one becomes garbage.
 *
 * Identity within an Extension is `id` (a SourceLocation). The aggregate's
 * `sources: ReadonlyMap<SourceLocation, Source>` is keyed by the
 * SourceLocation so the equality contract from
 * {@link sourceLocationEquals} flows through to map lookups.
 */
export interface Source {
  readonly id: SourceLocation;
  readonly kind: ExtensionKind;
  readonly fingerprint: SourceFingerprint;
  readonly state: RowState;
  readonly sourceMtime: string;
}

/**
 * Constructs a Source. All fields are required — there is no
 * "default state" Source. Callers that don't yet have a state should
 * construct an Indexed/Bundled/etc state first via the relevant
 * Extension transition method, not via direct Source construction.
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

/**
 * Returns a NEW Source with `state` replaced. Used by Extension
 * transitions to advance a Source through the RowState machine without
 * mutating the original. Caller is responsible for ensuring the
 * transition is valid per the RowState state-machine table.
 */
export function withState(source: Source, state: RowState): Source {
  return makeSource({
    id: source.id,
    kind: source.kind,
    fingerprint: source.fingerprint,
    state,
    sourceMtime: source.sourceMtime,
  });
}

/**
 * Returns a NEW Source with `fingerprint` and `state` replaced together.
 * Used by `observeFreshSource` and rebundle transitions where the
 * fingerprint and the resulting state both change atomically.
 */
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
