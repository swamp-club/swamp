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
 * Mirrors sanitizeReportNameForData in
 * src/domain/reports/report_data_name.ts, which names the data a report is
 * persisted under. report_name_test.ts pins the two together.
 */
export function sanitizeReportNameForData(reportName: string): string {
  return reportName
    .replace(/@/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\.\./g, ".")
    .replace(/\0/g, "");
}

/** The data name of a report's markdown output (its JSON is `<name>-json`). */
export function reportDataName(reportName: string, variant?: string): string {
  const base = `report-${sanitizeReportNameForData(reportName)}`;
  return variant ? `${base}-${variant}` : base;
}
