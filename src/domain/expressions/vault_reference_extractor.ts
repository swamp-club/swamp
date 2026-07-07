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

const EXPRESSION_PATTERN = /\$\{\{\s*(.+?)\s*\}\}/g;

const VAULT_GET_PATTERN =
  /vault\.get\(\s*(?:(['"`])(.+?)\1|([^\s,)]+))\s*,\s*(?:(['"`])(.+?)\4|([^\s,)]+))\s*\)/g;

export interface VaultReference {
  vaultName: string;
  secretKey: string;
}

export interface VaultExtractionResult {
  staticRefs: VaultReference[];
  hasDynamicRefs: boolean;
}

export function extractVaultReferences(
  ...dataSources: unknown[]
): VaultExtractionResult {
  const staticRefs: VaultReference[] = [];
  const seen = new Set<string>();
  let hasDynamicRefs = false;

  for (const data of dataSources) {
    collectVaultReferences(data, staticRefs, seen, (dynamic) => {
      if (dynamic) hasDynamicRefs = true;
    });
  }

  return { staticRefs, hasDynamicRefs };
}

function collectVaultReferences(
  data: unknown,
  refs: VaultReference[],
  seen: Set<string>,
  onDynamic: (isDynamic: boolean) => void,
): void {
  if (typeof data === "string") {
    for (const exprMatch of data.matchAll(EXPRESSION_PATTERN)) {
      const celExpr = exprMatch[1];
      VAULT_GET_PATTERN.lastIndex = 0;
      for (const vaultMatch of celExpr.matchAll(VAULT_GET_PATTERN)) {
        const vaultName = vaultMatch[2];
        const secretKey = vaultMatch[5];

        if (vaultName !== undefined && secretKey !== undefined) {
          const key = `${vaultName}\0${secretKey}`;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push({ vaultName, secretKey });
          }
        } else {
          onDynamic(true);
        }
      }
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      collectVaultReferences(item, refs, seen, onDynamic);
    }
  } else if (data !== null && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      collectVaultReferences(value, refs, seen, onDynamic);
    }
  }
}
