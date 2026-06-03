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
import { UserError } from "../../domain/errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface IssueEditData {
  issueNumber: number;
  title: string;
  body: string;
  serverUrl: string;
}

export type IssueEditEvent =
  | { kind: "completed"; data: IssueEditData }
  | { kind: "noop"; issueNumber: number }
  | { kind: "error"; error: SwampError };

export interface IssueEditInput {
  issueNumber: number;
  title?: string;
  body?: string;
  originalTitle: string;
  originalBody: string;
}

export interface IssueEditDeps {
  updateIssue: (input: {
    issueNumber: number;
    fields: { title?: string; body?: string };
  }) => Promise<{ title: string; body: string; serverUrl: string }>;
}

export async function* issueEdit(
  ctx: LibSwampContext,
  deps: IssueEditDeps,
  input: IssueEditInput,
): AsyncIterable<IssueEditEvent> {
  yield* withGeneratorSpan(
    "swamp.issue.edit",
    {},
    (async function* () {
      ctx.logger.debug`Editing issue #${input.issueNumber}`;

      const fields: { title?: string; body?: string } = {};

      if (
        input.title !== undefined && input.title !== input.originalTitle
      ) {
        fields.title = input.title;
      }
      if (input.body !== undefined && input.body !== input.originalBody) {
        fields.body = input.body;
      }

      if (Object.keys(fields).length === 0) {
        yield { kind: "noop", issueNumber: input.issueNumber };
        return;
      }

      if (fields.title !== undefined && fields.title.trim().length === 0) {
        throw new UserError("Title must not be empty.");
      }

      const result = await deps.updateIssue({
        issueNumber: input.issueNumber,
        fields,
      });

      yield {
        kind: "completed",
        data: {
          issueNumber: input.issueNumber,
          title: result.title,
          body: result.body,
          serverUrl: result.serverUrl,
        },
      };
    })(),
  );
}
