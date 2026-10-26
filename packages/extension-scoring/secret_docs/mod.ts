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

/**
 * The secret-safe-docs check: documentation that handles a secret in
 * plaintext, which files it reads, and how acceptances and caps decide the
 * `secret-safe-docs` factor.
 *
 * @module
 */

export {
  type ArgumentSchemas,
  argumentSchemas,
  detectSecretDocs,
  MAX_SCANNED_LINE_LENGTH,
  MAX_SCANNED_SECRET_DOCS_FINDINGS,
  MAX_SECRET_DOCS_FILE_BYTES,
  MAX_SECRET_DOCS_FILES,
  MAX_STORED_SECRET_DOCS_FINDINGS,
  type SchemaField,
  type SchemaMetadata,
  SECRET_UNSAFE_DOCS_RULE,
  type SecretDocsAcceptance,
  secretDocsAcceptanceMatcher,
  type SecretDocsAccepted,
  type SecretDocsFinding,
  type SecretDocsForm,
  type SecretDocsLocatedFinding,
  type SecretDocsResult,
  summarizeSecretDocs,
} from "./detector.ts";
export {
  type ArchiveFile,
  markdownImports,
  nonDocumentationPaths,
  type SecretDocsTarget,
  secretDocsTargets,
} from "./inputs.ts";
export { MARKED_SENSITIVE, namesSecretValue } from "./secret_names.ts";
export { SECRET_SAFE_DOCS_REMEDIATION } from "../rubric/score.ts";
