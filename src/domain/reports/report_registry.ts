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

import type { ReportDefinition, ReportScope } from "./report.ts";

/**
 * Registry of all known report definitions.
 */
export class ReportRegistry {
  private reports = new Map<string, ReportDefinition>();

  /**
   * Registers a report definition.
   *
   * @param name - Unique name for the report
   * @param report - The report definition
   * @throws If a report with the same name is already registered
   */
  register(name: string, report: ReportDefinition): void {
    if (this.reports.has(name)) {
      throw new Error(`Report already registered: ${name}`);
    }
    this.reports.set(name, report);
  }

  /**
   * Gets a report definition by name.
   */
  get(name: string): ReportDefinition | undefined {
    return this.reports.get(name);
  }

  /**
   * Returns all registered reports.
   */
  getAll(): Array<{ name: string; report: ReportDefinition }> {
    return Array.from(this.reports.entries()).map(([name, report]) => ({
      name,
      report,
    }));
  }

  /**
   * Returns all reports matching a specific scope.
   */
  getByScope(
    scope: ReportScope,
  ): Array<{ name: string; report: ReportDefinition }> {
    return this.getAll().filter(({ report }) => report.scope === scope);
  }

  /**
   * Checks if a report is registered.
   */
  has(name: string): boolean {
    return this.reports.has(name);
  }
}

/**
 * Global report registry instance.
 *
 * Uses globalThis so that the same registry is shared across module
 * boundaries (e.g., when extensions are loaded outside the bundle).
 */
const REPORT_REGISTRY_KEY = "__swampReportRegistry";
// deno-lint-ignore no-explicit-any
export const reportRegistry: ReportRegistry = (globalThis as any)[
  REPORT_REGISTRY_KEY
] ??= new ReportRegistry();
