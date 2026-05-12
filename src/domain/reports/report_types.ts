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

import { reportRegistry } from "./report_registry.ts";

export interface ReportTypeInfo {
  type: string;
  name: string;
  description: string;
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
    isBuiltIn: false,
  }));
  const loadedKeys = new Set(loaded.map((t) => t.type.toLowerCase()));

  const lazy = reportRegistry.getAllLazy()
    .filter((entry) => !loadedKeys.has(entry.type.toLowerCase()))
    .map((entry) => ({
      type: entry.type,
      name: entry.type,
      description: "",
      isBuiltIn: false,
    }));

  return [...loaded, ...lazy];
}
