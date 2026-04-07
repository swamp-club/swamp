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
/**
 * Data structure for the issue create output.
 */
export type IssueCreateData =
  | {
    method: "lab";
    number: number;
    type: "bug" | "feature" | "security";
    title: string;
    serverUrl: string;
  }
  | {
    method: "email";
    mailtoUrl: string;
    type: "bug" | "feature" | "security";
    title: string;
  };

export type IssueCreateEvent =
  | { kind: "completed"; data: IssueCreateData }
  | { kind: "error"; error: SwampError };

/** Input for the issue create operation. */
export interface IssueCreateInput {
  title: string;
  body: string;
  type: "bug" | "feature" | "security";
}

/** Dependencies for the issue create operation. */
export interface IssueCreateDeps {
  submitToLab: (input: {
    type: "bug" | "feature" | "security";
    title: string;
    body: string;
  }) => Promise<{ number: number; serverUrl: string }>;
}

/** Submits a bug or feature issue to the Lab API. */
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

      const labResult = await deps.submitToLab({
        type: input.type,
        title: input.title,
        body: input.body,
      });
      yield {
        kind: "completed",
        data: {
          method: "lab",
          number: labResult.number,
          type: input.type,
          title: input.title,
          serverUrl: labResult.serverUrl,
        },
      };
    })(),
  );
}
