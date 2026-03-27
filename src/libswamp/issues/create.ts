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

import { GitHubIssueService } from "../../infrastructure/github/github_issue_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the issue create output.
 */
export type IssueCreateData =
  | {
    method: "created";
    url: string;
    number: number;
    type: "bug" | "feature";
    title: string;
  }
  | {
    method: "url";
    url: string;
    type: "bug" | "feature";
    title: string;
    body: string;
    labels: string[];
  };

export type IssueCreateEvent =
  | { kind: "completed"; data: IssueCreateData }
  | { kind: "error"; error: SwampError };

/** Input for the issue create operation. */
export interface IssueCreateInput {
  title: string;
  body: string;
  labels: string[];
  type: "bug" | "feature";
}

/** Dependencies for the issue create operation. */
export interface IssueCreateDeps {
  createIssue: (opts: {
    title: string;
    body: string;
    labels: string[];
  }) => Promise<
    | { method: "created"; url: string; number: number }
    | { method: "url"; url: string; body: string; labels: string[] }
  >;
}

/** Wires real infrastructure into IssueCreateDeps. */
export function createIssueCreateDeps(): IssueCreateDeps {
  const githubService = new GitHubIssueService();
  return {
    createIssue: (opts) => githubService.createIssue(opts),
  };
}

/** Creates a GitHub issue (bug or feature request). */
export async function* issueCreate(
  ctx: LibSwampContext,
  deps: IssueCreateDeps,
  input: IssueCreateInput,
): AsyncIterable<IssueCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.issue.create",
    {},
    (async function* () {
      ctx.logger.debug`Creating ${input.type} issue: ${input.title}`;

      const result = await deps.createIssue({
        title: input.title,
        body: input.body,
        labels: input.labels,
      });

      const data: IssueCreateData = result.method === "created"
        ? {
          method: "created",
          url: result.url,
          number: result.number,
          type: input.type,
          title: input.title,
        }
        : {
          method: "url",
          url: result.url,
          type: input.type,
          title: input.title,
          body: result.body,
          labels: result.labels,
        };

      yield { kind: "completed", data };
    })(),
  );
}
