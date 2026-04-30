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
  warnings: ExtensionLoadWarning[];
}

const STATE_KEY = "__swampExtensionLoadWarningState";

// deno-lint-ignore no-explicit-any
const globalAny = globalThis as any;

function getState(): EmitterState {
  if (!globalAny[STATE_KEY]) {
    globalAny[STATE_KEY] = {
      emitted: new Set<string>(),
      hintsEmittedFor: new Set<ExtensionKind>(),
      warnings: [],
    } satisfies EmitterState;
  }
  return globalAny[STATE_KEY];
}

const HINT_BY_KIND: Record<ExtensionKind, string> = {
  model:
    "extensions/models/ is auto-discovered — running `swamp extension source add` here is a no-op.",
  extension:
    "extensions/models/ is auto-discovered — running `swamp extension source add` here is a no-op.",
  vault:
    "extensions/vaults/ is auto-discovered — running `swamp extension source add` here is a no-op.",
  driver:
    "extensions/drivers/ is auto-discovered — running `swamp extension source add` here is a no-op.",
  datastore:
    "extensions/datastores/ is auto-discovered — running `swamp extension source add` here is a no-op.",
  report:
    "extensions/reports/ is auto-discovered — running `swamp extension source add` here is a no-op.",
};

function defaultWriter(line: string): void {
  // Direct console.error bypasses LogTape — see file header.
  console.error(line);
}

function dedupeKey(warning: ExtensionLoadWarning): string {
  return `${warning.kind}\0${warning.file}\0${warning.error}`;
}

/**
 * Falls back to scanning Deno.args when the caller did not pass an
 * explicit `quiet` option. Lets domain-layer callers (which never
 * see Cliffy-parsed options) honour `swamp --quiet` without threading
 * a parameter through every call chain.
 *
 * Reading Deno.args couples this module to the CLI flag shape but
 * the alternative — a circular import from src/cli/ into
 * src/infrastructure/ — is worse. `--quiet` and `-q` are stable.
 */
function isSilenced(options: EmitterOptions): boolean {
  if (options.quiet === true) return true;
  if (options.quiet === false) return false;
  return Deno.args.includes("--quiet") || Deno.args.includes("-q");
}

/**
 * Writes a single `swamp-warning:` line to stderr (or the injected
 * writer). De-dupes on (kind, file, error). The first warning seen
 * for a given kind also emits a one-line `hint:` redirecting the
 * common wrong-turn (registering an extension source for a path
 * that's already auto-discovered).
 *
 * Capture is always-on: every unique warning is also pushed onto the
 * structured `warnings` array, regardless of quiet mode. `swamp doctor
 * extensions` reads the array via {@link getExtensionLoadWarnings} so
 * the diagnostic surface stays available even when stderr is muted.
 * Quiet mode only suppresses the writer call.
 */
export function emitExtensionLoadWarning(
  warning: ExtensionLoadWarning,
  options: EmitterOptions = {},
): void {
  const state = getState();
  const key = dedupeKey(warning);
  if (state.emitted.has(key)) return;
  state.emitted.add(key);
  state.warnings.push(warning);

  if (isSilenced(options)) return;

  const writer = options.writer ?? defaultWriter;
  writer(`swamp-warning: ${warning.file}: ${warning.error}`);

  if (!state.hintsEmittedFor.has(warning.kind)) {
    state.hintsEmittedFor.add(warning.kind);
    writer(`  hint: ${HINT_BY_KIND[warning.kind]}`);
  }
}

/**
 * Returns a defensive copy of the structured warnings captured so far.
 * Read by `swamp doctor extensions` to render its per-registry report.
 * Each unique (kind, file, error) tuple appears exactly once because
 * the emitter dedupes before pushing.
 */
export function getExtensionLoadWarnings(): ReadonlyArray<
  ExtensionLoadWarning
> {
  return [...getState().warnings];
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
 * Clears the emitter's process-scoped dedupe + hint-tracking state
 * AND the structured warnings array. Long-running processes (swamp
 * serve, swamp open) call this alongside ModelRegistry.resetLoadedFlag()
 * so a subsequent reload re-emits warnings cleanly. `swamp doctor
 * extensions` calls this before re-running loaders so its report
 * reflects only the warnings produced by its own pass.
 */
export function resetExtensionLoadWarnings(): void {
  const state = getState();
  state.emitted.clear();
  state.hintsEmittedFor.clear();
  state.warnings.length = 0;
}
