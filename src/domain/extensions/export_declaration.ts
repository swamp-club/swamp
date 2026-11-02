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

export type DeclarationKind =
  | "model"
  | "extension"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

const MODEL_EXPORT = /export\s+const\s+(model|behavior|extension)\s*[=:]/;

/**
 * kind adapters use these as exportRegex so the loader's pre-bundle check and
 * the catalog prune agree on what an entry point is
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
 * matches inside string, template or comment text are not declarations, so a
 * fixture's quoted export never becomes a catalog claim; offsets are kept, so
 * the result indexes the raw source
 */
export function findExportDeclaration(
  source: string,
  pattern: RegExp,
): number {
  const match = pattern.exec(stripCommentsAndStrings(source));
  return match ? match.index : -1;
}

export function declaresExport(source: string, pattern: RegExp): boolean {
  return findExportDeclaration(source, pattern) !== -1;
}

export function sourceFromExportDeclaration(
  source: string,
  pattern: RegExp,
): string | null {
  const offset = findExportDeclaration(source, pattern);
  return offset === -1 ? null : source.slice(offset);
}
