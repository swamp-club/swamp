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

export type ExtensionKind =
  | "model"
  | "extension"
  | "vault"
  | "driver"
  | "datastore"
  | "report";

export interface EmitterOptions {
  writer?: (line: string) => void;
  quiet?: boolean;
}

export interface ExtensionLoadWarningEvent {
  readonly kind: ExtensionKind;
  readonly file: string;
  readonly error: string;
}

interface EmitterState {
  emitted: Set<string>;
  events: ExtensionLoadWarningEvent[];
  hintsEmittedFor: Set<ExtensionKind>;
}

const STATE_KEY = "__swampExtensionLoadWarningState";

// deno-lint-ignore no-explicit-any
const globalAny = globalThis as any;

function getState(): EmitterState {
  if (!globalAny[STATE_KEY]) {
    globalAny[STATE_KEY] = {
      emitted: new Set<string>(),
      events: [],
      hintsEmittedFor: new Set<ExtensionKind>(),
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
  console.error(line);
}

function dedupeKey(kind: ExtensionKind, file: string, error: string): string {
  return `${kind}\0${file}\0${error}`;
}

function isSilenced(options: EmitterOptions): boolean {
  if (options.quiet === true) return true;
  if (options.quiet === false) return false;
  return Deno.args.includes("--quiet") || Deno.args.includes("-q");
}

export function emitExtensionLoadWarning(
  warning: { kind: ExtensionKind; file: string; error: string },
  options: EmitterOptions = {},
): void {
  const state = getState();
  const key = dedupeKey(warning.kind, warning.file, warning.error);
  if (state.emitted.has(key)) return;
  state.emitted.add(key);
  state.events.push({
    kind: warning.kind,
    file: warning.file,
    error: warning.error,
  });

  if (isSilenced(options)) return;

  const writer = options.writer ?? defaultWriter;
  writer(`swamp-warning: ${warning.file}: ${warning.error}`);

  if (!state.hintsEmittedFor.has(warning.kind)) {
    state.hintsEmittedFor.add(warning.kind);
    writer(`  hint: ${HINT_BY_KIND[warning.kind]}`);
  }
}

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

export function getExtensionLoadWarnings(): ReadonlyArray<
  ExtensionLoadWarningEvent
> {
  return Array.from(getState().events);
}

export function resetExtensionLoadWarnings(): void {
  const state = getState();
  state.emitted.clear();
  state.events.length = 0;
  state.hintsEmittedFor.clear();
}
