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

export type ModelCatalogLiteral = "type" | "version";

/**
 * not-plain-object: the export is not written as export const model = { ... }
 * (annotated, or a non-literal initializer); missing-literals: no
 * string-literal type or version
 */
export type ModelCatalogGap =
  | { kind: "not-plain-object"; annotated: boolean }
  | { kind: "missing-literals"; missing: ModelCatalogLiteral[] };

const MODEL_EXPORT_DECLARATION = /export\s+const\s+model\s*[=:]/;
const ANNOTATED_MODEL_EXPORT = /export\s+const\s+model\s*:/;
// behavior is the other spelling of the model export, read only when the file
// has no model export, as the catalog extractors do
const BEHAVIOR_EXPORT_DECLARATION = /export\s+const\s+behavior\s*[=:]/;
const ANNOTATED_BEHAVIOR_EXPORT = /export\s+const\s+behavior\s*:/;

/**
 * built on the catalog's extractors so they cannot disagree; like the catalog
 * it reads raw source, so an export inside a string before the real one is read
 * instead, with the verdict still matching
 */
export function modelCatalogGap(content: string): ModelCatalogGap | null {
  const spelledModel = declaresExport(content, MODEL_EXPORT_DECLARATION);
  if (
    !spelledModel && !declaresExport(content, BEHAVIOR_EXPORT_DECLARATION)
  ) {
    return null;
  }

  const type = extractModelType(content);
  const version = extractModelVersion(content);
  if (type && version) return null;

  if (extractModelExportBody(content) === null) {
    return {
      kind: "not-plain-object",
      annotated: declaresExport(
        content,
        spelledModel ? ANNOTATED_MODEL_EXPORT : ANNOTATED_BEHAVIOR_EXPORT,
      ),
    };
  }

  const missing: ModelCatalogLiteral[] = [];
  if (!type) missing.push("type");
  if (!version) missing.push("version");
  return { kind: "missing-literals", missing };
}
