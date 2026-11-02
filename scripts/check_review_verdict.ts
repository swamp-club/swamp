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
 * a review passes only on an explicit VERDICT: pass marker; there is no
 * inference, so a missing marker fails and a human looks
 */

export type MissingReason = "empty-output" | "no-marker";

export type ReviewVerdict =
  | { readonly kind: "pass" }
  | { readonly kind: "fail" }
  | { readonly kind: "missing"; readonly reason: MissingReason }
  | { readonly kind: "provider-error" };

/**
 * output at or below this size cannot be a real review; reported apart from a
 * marker-less review
 */
const MIN_SUBSTANTIVE_OUTPUT_BYTES = 50;

/**
 * checked before the marker so a truncated error page is never mistaken for a
 * review that declined to answer
 */
const PROVIDER_ERROR_PATTERN =
  /hit your (weekly|daily|monthly) limit|rate_limit_error|overloaded_error|authentication_error|invalid_api_key|credit balance is too low|exceeded your.*quota/i;

/**
 * matched outside markdown code only: reviewers quote error codes like
 * invalid_api_key, while the provider writes errors as raw text, never as code
 */
const FENCED_CODE_PATTERN = /^[ \t]*(`{3,})[\s\S]*?^[ \t]*\1/gm;
const INLINE_CODE_PATTERN = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;

/**
 * replaced by a space, not nothing, so neighbouring text cannot join into a new
 * match
 */
function withoutQuotedCode(output: string): string {
  return output.replace(FENCED_CODE_PATTERN, " ").replace(
    INLINE_CODE_PATTERN,
    " ",
  );
}

/**
 * anchored to line start: only a line-initial marker is the reviewer's answer,
 * not a mention while weighing pass or fail. asterisks and spaces may
 * interleave for markdown emphasis
 */
const VERDICT_MARKER_PATTERN = /^[ \t*]*VERDICT[ \t*]*:[ \t*]*(pass|fail)/im;

/** Count bytes, not UTF-16 code units, so the size floor means what it says. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function determineVerdict(output: string): ReviewVerdict {
  if (PROVIDER_ERROR_PATTERN.test(withoutQuotedCode(output))) {
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
 * the attestation reads this line, not the reviewer's prose, which can differ
 * after anchoring
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
