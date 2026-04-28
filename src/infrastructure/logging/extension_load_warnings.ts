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

/**
 * Stderr emitter for extension load failures.
 *
 * LogTape's JSON-mode configuration pins `lowestLevel` to "fatal"
 * (logger.ts:131-144), which silences the `logger.warn` lines
 * loaders use to surface failed extension loads. This module bypasses
 * LogTape entirely with a direct console.error write so warnings
 * remain visible regardless of output mode.
 *
 * State is keyed on globalThis so the dedupe + once-per-kind hint
 * tracking survives bundler-induced module duplication in the
 * compiled binary.
 */

export type ExtensionKind =
  | "model"
  | "extension"
  | "vault"
  | "driver"
  | "datastore"
  | "report";

export interface ExtensionLoadWarning {
  kind: ExtensionKind;
  file: string;
  error: string;
}

export interface EmitterOptions {
  writer?: (line: string) => void;
  quiet?: boolean;
}

interface EmitterState {
  emitted: Set<string>;
  hintsEmittedFor: Set<ExtensionKind>;
}

const STATE_KEY = "__swampExtensionLoadWarningState";

// deno-lint-ignore no-explicit-any
const globalAny = globalThis as any;

function getState(): EmitterState {
  if (!globalAny[STATE_KEY]) {
    globalAny[STATE_KEY] = {
      emitted: new Set<string>(),
      hintsEmittedFor: new Set<ExtensionKind>(),
    } satisfies EmitterState;
  }
  return globalAny[STATE_KEY];
}

const HINT_BY_KIND: Record<ExtensionKind, string> = {
  model:
    "extensions/models/ is auto-discovered — you do NOT need `swamp extension source add` for files in this directory.",
  extension:
    "extensions/models/ is auto-discovered — you do NOT need `swamp extension source add` for files in this directory.",
  vault:
    "extensions/vaults/ is auto-discovered — you do NOT need `swamp extension source add` for files in this directory.",
  driver:
    "extensions/drivers/ is auto-discovered — you do NOT need `swamp extension source add` for files in this directory.",
  datastore:
    "extensions/datastores/ is auto-discovered — you do NOT need `swamp extension source add` for files in this directory.",
  report:
    "extensions/reports/ is auto-discovered — you do NOT need `swamp extension source add` for files in this directory.",
};

function defaultWriter(line: string): void {
  // Direct console.error bypasses LogTape — see file header.
  console.error(line);
}

function dedupeKey(warning: ExtensionLoadWarning): string {
  return `${warning.kind}\0${warning.file}\0${warning.error}`;
}

/**
 * Writes a single `swamp-warning:` line to stderr (or the injected
 * writer). De-dupes on (kind, file, error). The first warning seen
 * for a given kind also emits a one-line `hint:` redirecting the
 * common wrong-turn (registering an extension source for a path
 * that's already auto-discovered).
 *
 * Quiet mode short-circuits to a no-op so `swamp --quiet` stays
 * quiet without callers having to filter.
 */
export function emitExtensionLoadWarning(
  warning: ExtensionLoadWarning,
  options: EmitterOptions = {},
): void {
  if (options.quiet) return;

  const state = getState();
  const key = dedupeKey(warning);
  if (state.emitted.has(key)) return;
  state.emitted.add(key);

  const writer = options.writer ?? defaultWriter;
  writer(`swamp-warning: ${warning.file}: ${warning.error}`);

  if (!state.hintsEmittedFor.has(warning.kind)) {
    state.hintsEmittedFor.add(warning.kind);
    writer(`  hint: ${HINT_BY_KIND[warning.kind]}`);
  }
}

/**
 * Convenience wrapper for buildIndex-style results that expose a
 * `failed` array of `{file, error}` records. Emits one warning per
 * failure under the given kind.
 */
export function recordLoadFailures(
  kind: ExtensionKind,
  result: { failed: ReadonlyArray<{ file: string; error: string }> },
  options: EmitterOptions = {},
): void {
  for (const failure of result.failed) {
    emitExtensionLoadWarning(
      { kind, file: failure.file, error: failure.error },
      options,
    );
  }
}

/**
 * Emit-only helper for the silent regex-mismatch path in each
 * loader's populateCatalogFromDir. Loaders perform their
 * kind-specific export check; if the file declares an export but
 * type extraction fails, they call this to surface the skip.
 *
 * Centralizing the message (not the regex — those stay per-loader
 * since each kind has its own pattern) keeps the user-facing
 * wording consistent across kinds.
 */
export function emitTypeExtractionFailure(
  file: string,
  kind: ExtensionKind,
  options: EmitterOptions = {},
): void {
  emitExtensionLoadWarning(
    {
      kind,
      file,
      error:
        'type field could not be extracted from the export block — must be a string literal, e.g. type: "@collective/name"',
    },
    options,
  );
}

/**
 * Clears the emitter's process-scoped dedupe + hint-tracking state.
 * Long-running processes (swamp serve, swamp open) call this
 * alongside ModelRegistry.resetLoadedFlag() so a subsequent reload
 * re-emits warnings cleanly.
 */
export function resetExtensionLoadWarnings(): void {
  const state = getState();
  state.emitted.clear();
  state.hintsEmittedFor.clear();
}
