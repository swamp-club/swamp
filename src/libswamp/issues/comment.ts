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
import { UserError } from "../../domain/errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/**
 * Server-side maximum comment length (matches MAX_COMMENT_LENGTH in
 * swamp-club's comments handler). Validated client-side so callers see a
 * clear error before round-tripping a too-long body.
 */
export const MAX_RIPPLE_LENGTH = 65_536;

/** Output of a successful ripple post. */
export interface IssueCommentData {
  issueNumber: number;
  commentId: string;
  serverUrl: string;
}

export type IssueCommentEvent =
  | { kind: "completed"; data: IssueCommentData }
  | { kind: "error"; error: SwampError };

export interface IssueCommentInput {
  issueNumber: number;
  body: string;
}

export interface IssueCommentDeps {
  submitToLab: (input: {
    issueNumber: number;
    body: string;
  }) => Promise<{ commentId: string; serverUrl: string }>;
}

/**
 * Post a "ripple" (comment) on an existing swamp-club Lab issue.
 *
 * Validates the body client-side to avoid round-tripping obviously bad
 * input. Server-side checks (profanity, comment-locked, visibility) are
 * surfaced through the infrastructure adapter as UserErrors.
 */
export async function* issueComment(
  ctx: LibSwampContext,
  deps: IssueCommentDeps,
  input: IssueCommentInput,
): AsyncIterable<IssueCommentEvent> {
  yield* withGeneratorSpan(
    "swamp.issue.comment",
    {},
    (async function* () {
      ctx.logger.debug`Posting ripple on issue #${input.issueNumber}`;

      const trimmed = input.body.trim();
      if (trimmed.length === 0) {
        throw new UserError("Ripple body must not be empty.");
      }
      if (input.body.length > MAX_RIPPLE_LENGTH) {
        throw new UserError(
          `Ripple body must not exceed ${MAX_RIPPLE_LENGTH} characters.`,
        );
      }

      const result = await deps.submitToLab({
        issueNumber: input.issueNumber,
        body: input.body,
      });

      yield {
        kind: "completed",
        data: {
          issueNumber: input.issueNumber,
          commentId: result.commentId,
          serverUrl: result.serverUrl,
        },
      };
    })(),
  );
}
