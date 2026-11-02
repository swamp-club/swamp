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

/**
 * asks the author what to do with redacted content before it is sent, so a
 * redaction that destroyed the evidence a report carries can be undone without
 * retyping.
 */

import type { RedactionSummary } from "../../domain/issues/content_redactor.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { renderRedactionSkipped } from "../../presentation/renderers/issue_create.ts";
import { promptLine } from "../prompt_helpers.ts";

export type RedactionDecision = "redacted" | "as-written" | "cancel";

export interface RedactionConfirmDeps {
  isInteractive: () => boolean;
  ask: (message: string) => Promise<string>;
}

function stdinIsTerminal(): boolean {
  try {
    return Deno.stdin.isTerminal();
  } catch {
    return false;
  }
}

const defaultDeps: RedactionConfirmDeps = {
  isInteractive: stdinIsTerminal,
  ask: promptLine,
};

/**
 * asks only when something was redacted, in log mode, with stdin a terminal;
 * json and scripted runs submit the redacted text since the notice already
 * reports each change. Any answer other than y or w cancels.
 */
export async function confirmRedactions(
  summary: RedactionSummary,
  mode: OutputMode,
  deps: RedactionConfirmDeps = defaultDeps,
): Promise<RedactionDecision> {
  if (summary.totalRedactions === 0) return "redacted";
  if (mode === "json" || !deps.isInteractive()) return "redacted";
  const answer = (await deps.ask(
    "\n  y = submit redacted\n  w = submit as written\n  N = cancel; nothing is sent (any other answer cancels; --no-redact skips redaction)\nSubmit? [y/w/N] ",
  )).toLowerCase();
  if (answer === "y" || answer === "yes") return "redacted";
  if (answer === "w" || answer === "written") return "as-written";
  return "cancel";
}

export async function chooseSubmittedContent<T>(
  summary: RedactionSummary,
  mode: OutputMode,
  content: { redacted: T; original: T },
  deps: RedactionConfirmDeps = defaultDeps,
): Promise<T | null> {
  const decision = await confirmRedactions(summary, mode, deps);
  if (decision === "cancel") return null;
  if (decision === "as-written") {
    renderRedactionSkipped(mode, "prompt");
    return content.original;
  }
  return content.redacted;
}
