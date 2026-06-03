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
  }
  | {
    /**
     * Lab submission tagged with an extension name — used when the caller
     * ran `swamp issue <type> --extension @swamp/<name>`. Same wire
     * contract as "lab"; the distinct method name lets the renderer say
     * "Filed against @swamp/<name>".
     */
    method: "extension-lab";
    number: number;
    type: "bug" | "feature" | "security";
    title: string;
    serverUrl: string;
    extensionName: string;
  };

export type IssueCreateEvent =
  | { kind: "completed"; data: IssueCreateData }
  | { kind: "error"; error: SwampError };

/** Input for the issue create operation. */
export interface IssueCreateInput {
  title: string;
  body: string;
  type: "bug" | "feature" | "security";
  /** Set for extension-scoped submissions; @swamp collectives route to Lab. */
  extensionName?: string;
  /** Installed version of `extensionName`, surfaced in the body. */
  extensionVersion?: string;
  /** Upstream repository URL from the manifest, surfaced in the body when set. */
  repositoryUrl?: string;
  /** Runtime context for reproducibility, appended to the body. */
  reporterContext?: ReporterContext;
}

/** Dependencies for the issue create operation. */
export interface IssueCreateDeps {
  submitToLab: (input: {
    type: "bug" | "feature" | "security";
    title: string;
    body: string;
  }) => Promise<{ number: number; serverUrl: string }>;
}

/** Submits a bug, feature, or security issue to the Lab API. */
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
      });

      if (input.extensionName) {
        yield {
          kind: "completed",
          data: {
            method: "extension-lab",
            number: labResult.number,
            type: input.type,
            title: input.title,
            serverUrl: labResult.serverUrl,
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
          serverUrl: labResult.serverUrl,
        },
      };
    })(),
  );
}

/**
 * Appends extension metadata and reporter context to the user-provided body.
 * Title is deliberately left alone — a `[@swamp/foo]` prefix would collide
 * with existing Lab UI title filters.
 *
 * Shares its formatting with the third-party repository path via
 * {@link assembleExtensionReportBody} so both destinations see identical
 * report bodies.
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
