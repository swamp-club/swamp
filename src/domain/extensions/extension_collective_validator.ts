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

/** A single content item whose collective doesn't match the extension's collective. */
export interface CollectiveMismatch {
  kind: "model" | "vault" | "workflow" | "driver" | "datastore";
  identifier: string;
  fileName: string;
}

/** Result of validating content collectives against the extension collective. */
export interface CollectiveValidationResult {
  valid: boolean;
  mismatches: CollectiveMismatch[];
}

/**
 * Validates that all content items (models, vaults, workflows, drivers, datastores) in an extension
 * use the same collective as the extension package itself.
 *
 * For example, if the extension is `@stack72/my-extension`, all model types,
 * vault types, workflow names, driver types, and datastore types must start with `@stack72/`.
 */
export function validateContentCollectives(
  extensionName: string,
  contentMetadata: ExtensionContentMetadata,
): CollectiveValidationResult {
  const slashIndex = extensionName.indexOf("/");
  if (slashIndex === -1) {
    return { valid: true, mismatches: [] };
  }
  const collectivePrefix = extensionName.slice(0, slashIndex + 1);

  const mismatches: CollectiveMismatch[] = [];

  for (const model of contentMetadata.models) {
    if (!model.type.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "model",
        identifier: model.type,
        fileName: model.fileName,
      });
    }
  }

  for (const vault of contentMetadata.vaults) {
    if (!vault.type.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "vault",
        identifier: vault.type,
        fileName: vault.fileName,
      });
    }
  }

  for (const workflow of contentMetadata.workflows) {
    if (!workflow.name.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "workflow",
        identifier: workflow.name,
        fileName: workflow.fileName,
      });
    }
  }

  for (const driver of contentMetadata.drivers) {
    if (!driver.type.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "driver",
        identifier: driver.type,
        fileName: driver.fileName,
      });
    }
  }

  for (const datastore of contentMetadata.datastores) {
    if (!datastore.type.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "datastore",
        identifier: datastore.type,
        fileName: datastore.fileName,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}
