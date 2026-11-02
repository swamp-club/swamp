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
import {
  assembleExtensionReportBody,
  type ReporterContext,
} from "../../domain/extensions/reporter_context.ts";
import type { IssueFilingSource } from "../../domain/issues/issue_source.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export type IssueCreateData =
  | {
    method: "lab";
    number: number;
    type: "bug" | "feature" | "security";
    title: string;
    url: string;
    /** Present only when the report was filed against the platform source. */
    source?: "platform";
  }
  | {
    method: "email";
    mailtoUrl: string;
    type: "bug" | "feature" | "security";
    title: string;
  }
  | {
    /**
     * same wire contract as lab; the distinct method lets the renderer say
     * "Filed against @swamp/<name>".
     */
    method: "extension-lab";
    number: number;
    type: "bug" | "feature" | "security";
    title: string;
    url: string;
    extensionName: string;
  };

export type IssueCreateEvent =
  | { kind: "completed"; data: IssueCreateData }
  | { kind: "error"; error: SwampError };

export interface IssueCreateInput {
  title: string;
  body: string;
  type: "bug" | "feature" | "security";
  source?: IssueFilingSource;
  /** Set for extension-scoped submissions; @swamp collectives route to Lab. */
  extensionName?: string;
  extensionVersion?: string;
  repositoryUrl?: string;
  reporterContext?: ReporterContext;
}

export interface IssueCreateDeps {
  submitToLab: (input: {
    type: "bug" | "feature" | "security";
    title: string;
    body: string;
    source?: IssueFilingSource;
  }) => Promise<{ number: number; url: string }>;
}

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

      const body = input.extensionName
        ? assembleExtensionLabBody(input)
        : input.body;

      const labResult = await deps.submitToLab({
        type: input.type,
        title: input.title,
        body,
        ...(input.source ? { source: input.source } : {}),
      });

      if (input.extensionName) {
        yield {
          kind: "completed",
          data: {
            method: "extension-lab",
            number: labResult.number,
            type: input.type,
            title: input.title,
            url: labResult.url,
            extensionName: input.extensionName,
          },
        };
        return;
      }

      yield {
        kind: "completed",
        data: {
          method: "lab",
          number: labResult.number,
          type: input.type,
          title: input.title,
          url: labResult.url,
          ...(input.source === "platform"
            ? { source: "platform" as const }
            : {}),
        },
      };
    })(),
  );
}

/**
 * the title is left alone: a [@swamp/foo] prefix would collide with existing
 * Lab UI title filters. Formatting is shared with the third-party repository
 * path so both destinations see identical bodies.
 */
function assembleExtensionLabBody(input: IssueCreateInput): string {
  if (!input.reporterContext) {
    // Extension metadata without reporter context — rare, only surfaces
    // when tests exercise the extension path without wiring a context.
    // Keep behavior forgiving: return the user body unchanged.
    return input.body;
  }
  return assembleExtensionReportBody(
    input.body,
    input.repositoryUrl,
    input.reporterContext,
  );
}
