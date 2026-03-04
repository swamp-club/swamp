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

import type { ExtensionContentMetadata } from "./extension_content.ts";

/** A single content item whose namespace doesn't match the extension's namespace. */
export interface NamespaceMismatch {
  kind: "model" | "vault" | "workflow";
  identifier: string;
  fileName: string;
}

/** Result of validating content namespaces against the extension namespace. */
export interface NamespaceValidationResult {
  valid: boolean;
  mismatches: NamespaceMismatch[];
}

/**
 * Validates that all content items (models, vaults, workflows) in an extension
 * use the same namespace as the extension package itself.
 *
 * For example, if the extension is `@stack72/my-extension`, all model types,
 * vault types, and workflow names must start with `@stack72/`.
 */
export function validateContentNamespaces(
  extensionName: string,
  contentMetadata: ExtensionContentMetadata,
): NamespaceValidationResult {
  const slashIndex = extensionName.indexOf("/");
  if (slashIndex === -1) {
    return { valid: true, mismatches: [] };
  }
  const namespacePrefix = extensionName.slice(0, slashIndex + 1);

  const mismatches: NamespaceMismatch[] = [];

  for (const model of contentMetadata.models) {
    if (!model.type.startsWith(namespacePrefix)) {
      mismatches.push({
        kind: "model",
        identifier: model.type,
        fileName: model.fileName,
      });
    }
  }

  for (const vault of contentMetadata.vaults) {
    if (!vault.type.startsWith(namespacePrefix)) {
      mismatches.push({
        kind: "vault",
        identifier: vault.type,
        fileName: vault.fileName,
      });
    }
  }

  for (const workflow of contentMetadata.workflows) {
    if (!workflow.name.startsWith(namespacePrefix)) {
      mismatches.push({
        kind: "workflow",
        identifier: workflow.name,
        fileName: workflow.fileName,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}
