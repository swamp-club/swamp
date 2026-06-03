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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface IssueSearchItem {
  number: number;
  title: string;
  type: string;
  status: string;
  author: string;
}

export interface IssueSearchData {
  issues: IssueSearchItem[];
  total: number;
  serverUrl: string;
}

export type IssueSearchEvent =
  | { kind: "completed"; data: IssueSearchData }
  | { kind: "error"; error: SwampError };

export interface IssueSearchInput {
  q?: string;
  type?: string;
  status?: string;
  source?: string;
  limit?: number;
}

export interface IssueSearchDeps {
  searchIssues: (input: IssueSearchInput) => Promise<IssueSearchData>;
}

export async function* issueSearch(
  ctx: LibSwampContext,
  deps: IssueSearchDeps,
  input: IssueSearchInput,
): AsyncIterable<IssueSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.issue.search",
    {},
    (async function* () {
      ctx.logger.debug`Searching issues${input.q ? ` for ${input.q}` : ""}`;

      const result = await deps.searchIssues(input);

      yield {
        kind: "completed",
        data: result,
      };
    })(),
  );
}
