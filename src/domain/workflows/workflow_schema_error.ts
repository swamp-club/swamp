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

import { z } from "zod";
import { escapeControlCharacters } from "../control_characters.ts";
import { UserError } from "../errors.ts";

/** One rule a workflow document breaks, and where in the document. */
export interface WorkflowSchemaIssue {
  /** Where the issue sits, e.g. `jobs[0].steps[0].name`; empty at the root. */
  readonly path: string;
  readonly message: string;
}

function formatIssue(issue: WorkflowSchemaIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/**
 * A workflow document that fails the workflow schema.
 *
 * The message is one `path: message` entry per issue on a single line, so it
 * reads cleanly wherever a caller embeds it (swamp-club#3062). Paths and
 * messages can carry author-controlled text — a record key, an unknown key
 * name — so control characters are escaped before they reach a terminal.
 */
export class WorkflowSchemaError extends UserError {
  readonly issues: readonly WorkflowSchemaIssue[];

  constructor(issues: readonly WorkflowSchemaIssue[], source?: string) {
    const text = issues.map(formatIssue).join("; ");
    super(source ? `${source}: ${text}` : text);
    this.name = "WorkflowSchemaError";
    this.issues = issues;
  }

  static fromZodError(error: z.ZodError): WorkflowSchemaError {
    return new WorkflowSchemaError(
      error.issues.map((issue) => ({
        path: escapeControlCharacters(z.core.toDotPath(issue.path)),
        message: escapeControlCharacters(issue.message),
      })),
    );
  }

  /**
   * The same error with the file that holds the document named in front.
   * Pass a file name, not an absolute path: `swamp serve` withholds any
   * message that carries one from its clients.
   */
  inFile(fileName: string): WorkflowSchemaError {
    return new WorkflowSchemaError(
      this.issues,
      escapeControlCharacters(fileName),
    );
  }
}
