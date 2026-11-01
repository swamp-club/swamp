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
 * The Lab sources the CLI can file an issue against. A source says what an
 * issue is raised against; it is a separate field from the issue type, so the
 * `platform` source has nothing to do with the admin-only `platform` type.
 */
export const ISSUE_FILING_SOURCES = ["swamp", "platform"] as const;

export type IssueFilingSource = typeof ISSUE_FILING_SOURCES[number];

/** The source a report is filed with when none is chosen. */
export const DEFAULT_ISSUE_FILING_SOURCE: IssueFilingSource = "swamp";

/** `value` as a filing source, or a UserError naming the accepted values. */
export function parseIssueFilingSource(value: string): IssueFilingSource {
  const source = ISSUE_FILING_SOURCES.find((known) => known === value);
  if (source === undefined) {
    throw new UserError(
      `--source must be one of: ${ISSUE_FILING_SOURCES.join(", ")}.`,
    );
  }
  return source;
}
