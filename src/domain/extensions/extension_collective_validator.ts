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

import type { ExtensionContentMetadata } from "./extension_content.ts";

export interface CollectiveMismatch {
  kind: "model" | "vault" | "workflow" | "datastore" | "report" | "webhook";
  identifier: string;
  fileName: string;
}

export interface CollectiveValidationResult {
  valid: boolean;
  mismatches: CollectiveMismatch[];
}

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

  for (const datastore of contentMetadata.datastores) {
    if (!datastore.type.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "datastore",
        identifier: datastore.type,
        fileName: datastore.fileName,
      });
    }
  }

  for (const report of contentMetadata.reports) {
    if (!report.name.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "report",
        identifier: report.name,
        fileName: report.fileName,
      });
    }
  }

  for (const webhook of contentMetadata.webhooks) {
    if (!webhook.type.startsWith(collectivePrefix)) {
      mismatches.push({
        kind: "webhook",
        identifier: webhook.type,
        fileName: webhook.fileName,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}

export interface RuntimeContentType {
  kind: CollectiveMismatch["kind"];
  typeNormalized: string;
  fileName: string;
}

/**
 * static metadata reads a type only when written as a string literal, so
 * constant, spread or computed types are checked here against the identity the
 * loader registers
 */
export function collectiveMismatchesForTypes(
  extensionName: string,
  types: readonly RuntimeContentType[],
): CollectiveMismatch[] {
  const slashIndex = extensionName.indexOf("/");
  if (slashIndex === -1) return [];
  const collectivePrefix = extensionName.slice(0, slashIndex + 1)
    .toLowerCase();
  return types
    .filter((t) => !t.typeNormalized.toLowerCase().startsWith(collectivePrefix))
    .map((t) => ({
      kind: t.kind,
      identifier: t.typeNormalized,
      fileName: t.fileName,
    }));
}
