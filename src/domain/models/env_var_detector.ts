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

import type { Definition } from "../definitions/definition.ts";
import type { EnvVarUsageDetail } from "./validation_service.ts";

/**
 * Scans a definition for environment variable references in expressions.
 *
 * Searches globalArguments and method data for `${{ env.VAR }}` patterns
 * and returns a list of paths and env var names found.
 */
export function detectEnvVarUsageInDefinition(
  definition: Definition,
): EnvVarUsageDetail[] {
  const usages: EnvVarUsageDetail[] = [];

  collectEnvVarUsages(
    definition.globalArguments,
    "globalArguments",
    usages,
  );

  for (
    const [methodName, methodData] of Object.entries(definition.methodData)
  ) {
    collectEnvVarUsages(
      methodData,
      `methods.${methodName}`,
      usages,
    );
  }

  return usages;
}

/**
 * Recursively collects env var references from a data structure.
 */
function collectEnvVarUsages(
  data: unknown,
  basePath: string,
  usages: EnvVarUsageDetail[],
): void {
  if (typeof data === "string") {
    const exprPattern = /\$\{\{\s*(.+?)\s*\}\}/g;
    for (const match of data.matchAll(exprPattern)) {
      const celExpr = match[1];
      const envPattern = /\benv\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
      for (const envMatch of celExpr.matchAll(envPattern)) {
        usages.push({
          path: basePath,
          envVar: envMatch[1],
        });
      }
    }
  } else if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      collectEnvVarUsages(data[i], `${basePath}[${i}]`, usages);
    }
  } else if (data !== null && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      collectEnvVarUsages(value, `${basePath}.${key}`, usages);
    }
  }
}
