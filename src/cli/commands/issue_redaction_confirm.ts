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
 * Asks the author what to do with redacted issue content before it is sent,
 * so a redaction that destroyed the evidence a report exists to carry can be
 * undone without retyping the report (swamp-club#3686).
 */

import type { RedactionSummary } from "../../domain/issues/content_redactor.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { renderRedactionSkipped } from "../../presentation/renderers/issue_create.ts";
import { promptLine } from "../prompt_helpers.ts";

/** What to submit: the redacted text, the text as written, or nothing. */
export type RedactionDecision = "redacted" | "as-written" | "cancel";

export interface RedactionConfirmDeps {
  /** Whether stdin is a terminal a person can answer from. */
  isInteractive: () => boolean;
  /** Writes the question to stderr and returns the trimmed answer ("" on EOF). */
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
 * Called after the redaction notice has listed every change. Asks only when
 * something was redacted, the output mode is log, and stdin is a terminal;
 * json mode and scripted runs submit the redacted text as before, since the
 * notice already reports each change. Any answer other than y or w cancels.
 */
export async function confirmRedactions(
  summary: RedactionSummary,
  mode: OutputMode,
  deps: RedactionConfirmDeps = defaultDeps,
): Promise<RedactionDecision> {
  if (summary.totalRedactions === 0) return "redacted";
  if (mode === "json" || !deps.isInteractive()) return "redacted";
  const answer = (await deps.ask(
    "  y = submit redacted\n  w = submit as written\n  N = cancel (any other answer cancels)\nSubmit? [y/w/N] ",
  )).toLowerCase();
  if (answer === "y" || answer === "yes") return "redacted";
  if (answer === "w" || answer === "written") return "as-written";
  return "cancel";
}

/**
 * Picks the content to submit once the redaction notice has been shown:
 * the redacted content, the original when the author answers w (which is
 * logged like --no-redact), or null when they cancel.
 */
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
