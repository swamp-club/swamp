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

// ---------------------------------------------------------------------------
// Lifecycle Recording Policy
// ---------------------------------------------------------------------------
//
// Deciding whether a dropped upstream write should fail the step is the
// model's policy, not the API adapter's job. `SwampClubClient` reports what
// happened; this module decides what it means.
//
// The split it encodes already existed implicitly in the model: `start`
// raises when swamp-club is unreachable or the issue is missing, while
// auto-assignment only warns. One function per kind of call site makes that
// distinction something a call site declares rather than implies.

import type {
  LifecycleEntryParams,
  SwampClubClient,
  UpstreamOutcome,
} from "./swamp_club.ts";

/** The logger shape every model method already receives. */
export interface RecorderLogger {
  info: (msg: string, props: Record<string, unknown>) => void;
  warning: (msg: string, props: Record<string, unknown>) => void;
}

/**
 * Render an outcome as an operator-facing sentence.
 *
 * The server's own response body is included verbatim: it carries the reason
 * the write was refused, which is what the operator needs to fix the payload
 * and re-run.
 */
function explain(label: string, outcome: UpstreamOutcome): string {
  if (outcome.ok) return `${label} succeeded`;
  if (outcome.reason === "rejected") {
    return `swamp-club rejected the ${label}: HTTP ${outcome.status} — ` +
      `${outcome.body}. The upstream record was not written. Fix the payload ` +
      `and re-run this method.`;
  }
  return `swamp-club was unreachable while writing the ${label}: ` +
    `${outcome.detail}. The upstream record was not written.`;
}

/**
 * Post a mandatory audit entry. Raises when it is not accepted.
 *
 * Returns quietly with no client: no credentials, or swamp-club failed the
 * reachability probe, both of which `createSwampClubClient` already warned
 * about. Offline operation stays supported; a reachable server silently
 * dropping the record does not.
 */
export async function recordLifecycle(
  sc: SwampClubClient | null,
  params: LifecycleEntryParams,
): Promise<void> {
  if (!sc) return;
  const outcome = await sc.postLifecycleEntry(params);
  if (outcome.ok) return;
  throw new Error(explain(`${params.step} lifecycle entry`, outcome));
}

/**
 * Post an entry that reports on a courtesy action, logging a warning instead
 * of raising. Use only where the action being reported is itself best-effort
 * — otherwise the audit trail and the step's exit status disagree.
 */
export async function recordLifecycleBestEffort(
  sc: SwampClubClient | null,
  logger: RecorderLogger,
  params: LifecycleEntryParams,
): Promise<void> {
  if (!sc) return;
  const outcome = await sc.postLifecycleEntry(params);
  if (outcome.ok) return;
  logger.warning("{message}", {
    message: explain(`${params.step} lifecycle entry`, outcome),
  });
}

/** Submit a contributor ripple. Raises when it is not accepted. */
export async function recordRipple(
  sc: SwampClubClient | null,
  body: string,
): Promise<void> {
  if (!sc) return;
  const outcome = await sc.submitComment(body);
  if (outcome.ok) return;
  throw new Error(explain("contributor ripple", outcome));
}

/**
 * Interpret an outcome already produced by `transitionStatus` or
 * `updateType`. Raises on failure, so the two differ only in the benign rule
 * the client gives them and share one failure policy here.
 *
 * `undefined` means no client, so nothing was attempted.
 */
export function recordUpstreamChange(
  logger: RecorderLogger,
  label: string,
  outcome: UpstreamOutcome | undefined,
): void {
  if (!outcome) return;
  if (outcome.ok) {
    if (outcome.noop) {
      logger.info("{label} was already applied upstream", { label });
    }
    return;
  }
  throw new Error(explain(label, outcome));
}
