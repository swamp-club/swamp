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
 * The verdict rule for the pre-PR agent reviews.
 *
 * This is the single place that decides whether a review passed. It is shared
 * by every review step in `verification/workflow-submit-change.yaml`; the
 * steps own the reviewer invocation, this owns the decision.
 *
 * A review passes only when the reviewer states an explicit `VERDICT: pass`
 * marker. There is deliberately no inference: a reviewer that does not answer
 * in the required format is precisely when a human should look, so a missing
 * marker fails the step rather than being read as either outcome.
 */

/** Why no usable verdict marker was found. */
export type MissingReason = "empty-output" | "no-marker";

/** The gate's decision about one review's output. */
export type ReviewVerdict =
  | { readonly kind: "pass" }
  | { readonly kind: "fail" }
  | { readonly kind: "missing"; readonly reason: MissingReason }
  | { readonly kind: "provider-error" };

/**
 * Output at or below this many bytes cannot be a real review. Reported
 * separately from a marker-less review so the operator can tell "the reviewer
 * said nothing" from "the reviewer answered in the wrong format".
 */
const MIN_SUBSTANTIVE_OUTPUT_BYTES = 50;

/**
 * Provider failures mean no review ran at all. Detected before the marker so a
 * truncated error page can never be mistaken for a review that declined to
 * answer.
 */
const PROVIDER_ERROR_PATTERN =
  /hit your (weekly|daily|monthly) limit|rate_limit_error|overloaded_error|authentication_error|invalid_api_key|credit balance is too low|exceeded your.*quota/i;

/**
 * The verdict marker, anchored to the start of a line.
 *
 * Anchoring is load-bearing. The reviewer is told to begin its response with
 * the marker, so only a line-initial marker is its answer. An unanchored match
 * would score a review on the first mention anywhere in the text — including a
 * reviewer weighing out loud whether to emit pass or fail, or quoting the
 * instruction back — which, now that a missing marker fails, is the only way a
 * review could be credited with a verdict it never gave.
 *
 * Asterisks and spaces are allowed to interleave freely around the marker,
 * because reviewers emphasise it in markdown in several shapes — `**VERDICT:
 * pass**`, `**VERDICT:** **pass**`, a bulleted `* VERDICT: pass`. The previous
 * shell pattern tolerated emphasis too, and narrowing that here would turn
 * passing reviews into failures.
 */
const VERDICT_MARKER_PATTERN = /^[ \t*]*VERDICT[ \t*]*:[ \t*]*(pass|fail)/im;

/** Count bytes, not UTF-16 code units, so the size floor means what it says. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Decide the verdict for one review's raw output.
 *
 * Pure: no I/O, no process state. The CLI wrapper below is the only part that
 * touches the filesystem.
 */
export function determineVerdict(output: string): ReviewVerdict {
  if (PROVIDER_ERROR_PATTERN.test(output)) {
    return { kind: "provider-error" };
  }

  const marker = output.match(VERDICT_MARKER_PATTERN);
  if (marker) {
    return marker[1].toLowerCase() === "pass" ? { kind: "pass" } : {
      kind: "fail",
    };
  }

  if (byteLength(output) < MIN_SUBSTANTIVE_OUTPUT_BYTES) {
    return { kind: "missing", reason: "empty-output" };
  }
  return { kind: "missing", reason: "no-marker" };
}

/**
 * The verdict as it is written to the log.
 *
 * The attestation records what the gate decided, so it reads this line rather
 * than the reviewer's prose — after anchoring, the two can legitimately differ.
 */
export function formatGateVerdict(verdict: ReviewVerdict): string {
  return `GATE_VERDICT: ${verdict.kind}`;
}

function reportFailure(label: string, verdict: ReviewVerdict, output: string) {
  if (verdict.kind === "provider-error") {
    console.error(
      "::error::Provider error detected in review output — no review was performed",
    );
    // The output is the only evidence of what the provider actually returned.
    console.error(output);
    return;
  }
  if (verdict.kind === "missing") {
    const detail = verdict.reason === "empty-output"
      ? "the reviewer produced no substantive output"
      : "the reviewer did not state a VERDICT marker";
    console.error(
      `::error::${label} did not pass (verdict: missing) — ${detail}. ` +
        "A review that does not answer in the required format needs a human to look.",
    );
    return;
  }
  console.error(`::error::${label} did not pass (verdict: fail)`);
}

async function main(): Promise<number> {
  const [resultPath, label] = Deno.args;
  if (!resultPath || !label) {
    console.error(
      "::error::usage: check_review_verdict.ts <result-file> <review-label>",
    );
    return 2;
  }

  let output: string;
  try {
    output = await Deno.readTextFile(resultPath);
  } catch (err) {
    console.error(
      `::error::${label} did not pass (verdict: missing) — could not read the review output: ${err}`,
    );
    return 1;
  }

  const verdict = determineVerdict(output);
  console.log(formatGateVerdict(verdict));

  if (verdict.kind === "pass") {
    return 0;
  }
  reportFailure(label, verdict, output);
  return 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
