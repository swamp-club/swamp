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

import { UserError } from "../errors.ts";

/**
 * the filing source is a separate field from the issue type; the platform
 * source has nothing to do with the admin-only platform type
 */
export const ISSUE_FILING_SOURCES = ["swamp", "platform"] as const;

export type IssueFilingSource = typeof ISSUE_FILING_SOURCES[number];

export const DEFAULT_ISSUE_FILING_SOURCE: IssueFilingSource = "swamp";

export function parseIssueFilingSource(value: string): IssueFilingSource {
  const source = ISSUE_FILING_SOURCES.find((known) => known === value);
  if (source === undefined) {
    throw new UserError(
      `--source must be one of: ${ISSUE_FILING_SOURCES.join(", ")}.`,
    );
  }
  return source;
}
