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

import { stripCommentsAndStrings } from "./extension_quality_checker.ts";

/** The catalog kinds a source can claim a type for. */
export type DeclarationKind =
  | "model"
  | "extension"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

const MODEL_EXPORT = /export\s+const\s+(model|extension)\s*[=:]/;

/**
 * The `export const` declaration each catalog kind is defined by. The kind
 * adapters use these as their `exportRegex`, so the loader's pre-bundle
 * check and the catalog prune agree on what an entry point is.
 */
export const EXPORT_DECLARATION_PATTERNS: Readonly<
  Record<DeclarationKind, RegExp>
> = {
  model: MODEL_EXPORT,
  extension: MODEL_EXPORT,
  vault: /export\s+const\s+vault\s*[=:]/,
  datastore: /export\s+const\s+datastore\s*[=:]/,
  report: /export\s+const\s+report\s*[=:]/,
  webhook: /export\s+const\s+webhook\s*[=:]/,
};

/**
 * Returns the offset in `source` of the first match of `pattern` that lies
 * in code, or -1. Matches inside string, template or comment text are not
 * declarations: a test fixture such as
 * `` const src = `export const model = { type: "@acme/thing" }` `` names a
 * type no module exports, and must not become a catalog claim
 * (swamp-club#2876).
 *
 * `stripCommentsAndStrings` keeps every offset, so the returned offset
 * indexes the raw source.
 */
export function findExportDeclaration(
  source: string,
  pattern: RegExp,
): number {
  const match = pattern.exec(stripCommentsAndStrings(source));
  return match ? match.index : -1;
}

/** True when `source` declares `pattern` in code rather than in a literal. */
export function declaresExport(source: string, pattern: RegExp): boolean {
  return findExportDeclaration(source, pattern) !== -1;
}

/**
 * The raw source from the first declaration matching `pattern` onward, or
 * null when there is none in code. Callers run their own field regexes
 * over the result, so string values such as the `type` stay readable.
 */
export function sourceFromExportDeclaration(
  source: string,
  pattern: RegExp,
): string | null {
  const offset = findExportDeclaration(source, pattern);
  return offset === -1 ? null : source.slice(offset);
}
