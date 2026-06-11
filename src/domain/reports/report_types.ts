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

import type { ReportScope } from "./report.ts";
import {
  BUILTIN_METHOD_REPORTS,
  BUILTIN_WORKFLOW_REPORTS,
} from "./builtin/mod.ts";
import { reportRegistry } from "./report_registry.ts";

const BUILTIN_NAMES = new Set([
  ...BUILTIN_METHOD_REPORTS,
  ...BUILTIN_WORKFLOW_REPORTS,
]);

export interface ReportTypeInfo {
  type: string;
  name: string;
  description: string;
  scope: ReportScope;
  isBuiltIn: boolean;
}

/**
 * Gets all available report types (both loaded and lazy).
 * Lazy types are synthesized from catalog metadata.
 */
export function getReportTypes(): ReportTypeInfo[] {
  const loaded = reportRegistry.getAll().map(({ name, report }) => ({
    type: name,
    name,
    description: report.description,
    scope: report.scope,
    isBuiltIn: BUILTIN_NAMES.has(name),
  }));
  const loadedKeys = new Set(loaded.map((t) => t.type.toLowerCase()));

  const lazy = reportRegistry.getAllLazy()
    .filter((entry) => !loadedKeys.has(entry.type.toLowerCase()))
    .map((entry) => ({
      type: entry.type,
      name: entry.type,
      description: "",
      scope: "method" as ReportScope,
      isBuiltIn: false,
    }));

  return [...loaded, ...lazy];
}
