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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface IssueGetData {
  number: number;
  title: string;
  type: string;
  status: string;
  author: string;
  body: string;
  assignees: string[];
  commentCount: number;
  serverUrl: string;
}

export type IssueGetEvent =
  | { kind: "completed"; data: IssueGetData }
  | { kind: "error"; error: SwampError };

export interface IssueGetInput {
  issueNumber: number;
}

export interface IssueGetDeps {
  fetchIssue: (issueNumber: number) => Promise<IssueGetData>;
}

export async function* issueGet(
  ctx: LibSwampContext,
  deps: IssueGetDeps,
  input: IssueGetInput,
): AsyncIterable<IssueGetEvent> {
  yield* withGeneratorSpan(
    "swamp.issue.get",
    {},
    (async function* () {
      ctx.logger.debug`Fetching issue #${input.issueNumber}`;

      const result = await deps.fetchIssue(input.issueNumber);

      yield {
        kind: "completed",
        data: result,
      };
    })(),
  );
}
