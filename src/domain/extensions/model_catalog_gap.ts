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
  extractModelExportBody,
  extractModelType,
  extractModelVersion,
} from "./extension_content_extractor.ts";
import { declaresExport } from "./export_declaration.ts";

/** A model fact the push metadata reads as a string literal. */
export type ModelCatalogLiteral = "type" | "version";

/**
 * Why the registry catalog would leave a model entry point out:
 * `not-plain-object` when the export is not written as
 * `export const model = { ... }` (a type annotation, or an initializer that
 * is not an object literal), `missing-literals` when the object has no
 * string-literal `type` or `version`.
 */
export type ModelCatalogGap =
  | { kind: "not-plain-object"; annotated: boolean }
  | { kind: "missing-literals"; missing: ModelCatalogLiteral[] };

const MODEL_EXPORT_DECLARATION = /export\s+const\s+model\s*[=:]/;
const ANNOTATED_MODEL_EXPORT = /export\s+const\s+model\s*:/;

/**
 * Says why `extractContentMetadata` would not list a model file, or returns
 * null when it would. A file that declares no model export in code (an
 * extension, vault or other file, or a fixture whose export is only inside a
 * string) is never a gap. Built on the extractors the catalog uses, so the
 * two cannot disagree (swamp-club#2486). Like the catalog, the object body
 * is found in the raw source, so an `export const model = {` inside a string
 * ahead of the real export is read in its place; the verdict still matches
 * the catalog, only the reason may describe that text.
 */
export function modelCatalogGap(content: string): ModelCatalogGap | null {
  if (!declaresExport(content, MODEL_EXPORT_DECLARATION)) return null;

  const type = extractModelType(content);
  const version = extractModelVersion(content);
  if (type && version) return null;

  if (extractModelExportBody(content) === null) {
    return {
      kind: "not-plain-object",
      annotated: declaresExport(content, ANNOTATED_MODEL_EXPORT),
    };
  }

  const missing: ModelCatalogLiteral[] = [];
  if (!type) missing.push("type");
  if (!version) missing.push("version");
  return { kind: "missing-literals", missing };
}
