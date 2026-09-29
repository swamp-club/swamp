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
// Linked Issue Fan-out Policy
// ---------------------------------------------------------------------------
//
// A lifecycle can carry other issues alongside its own (`link_issue`). This
// module decides how each upstream write reaches them, alongside
// `lifecycle_recorder.ts`, which makes the same call for the primary issue.
//
// Status walks and PR links are fatal. Both are idempotent — a status that
// already landed is a no-op and the PR PATCH writes the same value — so a
// raised failure rolls the method back and the re-run converges.
//
// Mirrored entries are best-effort. An entry post cannot be taken back, so
// raising after the first of several would re-post it on the re-run. The
// primary issue's own entry stays the audit record.
//
// A mirror is never a copy of the primary's entry. It is a fixed sentence
// per milestone carrying only structured fields, so operator free text and
// the primary's title never reach a linked issue — the primary may be
// restricted to admins (security, platform) while the linked issue is
// public.

import type { ForwardStatus } from "./issue_status.ts";
import type { LinkedIssueData, LinkedIssuesData } from "./schemas.ts";
import type { LifecycleEntryParams, SwampClubClient } from "./swamp_club.ts";
import {
  type RecorderLogger,
  recordLifecycleBestEffort,
  recordUpstreamChange,
} from "./lifecycle_recorder.ts";

/** Read the linked issues, or none when the lifecycle carries none. */
export async function readLinkedIssues(
  readResource:
    | ((instanceName: string) => Promise<Record<string, unknown> | null>)
    | undefined,
): Promise<LinkedIssueData[]> {
  if (!readResource) return [];
  const data = await readResource("linkedIssues-main") as
    | LinkedIssuesData
    | null;
  return data?.issues ?? [];
}

/** Walk every linked issue to `target`. Raises on the first failure. */
export async function advanceLinked(
  sc: SwampClubClient | null,
  linked: LinkedIssueData[],
  target: ForwardStatus,
  logger: RecorderLogger,
): Promise<void> {
  if (!sc) return;
  for (const issue of linked) {
    recordUpstreamChange(
      logger,
      `status transition of linked issue #${issue.issueNumber} to ${target}`,
      await sc.forIssue(issue.issueNumber).walkStatusTo(target),
    );
  }
}

/** Record the PR on every linked issue. Raises on the first failure. */
export async function linkPrOnLinked(
  sc: SwampClubClient | null,
  linked: LinkedIssueData[],
  url: string,
  logger: RecorderLogger,
): Promise<void> {
  if (!sc) return;
  for (const issue of linked) {
    recordUpstreamChange(
      logger,
      `PR link on linked issue #${issue.issueNumber}`,
      await sc.forIssue(issue.issueNumber).linkPr(url),
    );
  }
}

/** The primary-issue milestones a linked issue hears about. */
export type Milestone =
  | { step: "implementation_started" }
  | { step: "verification_passed"; commit: string }
  | { step: "attestation_posted"; attestationId: string; commit: string }
  | { step: "pr_linked"; url: string; attempt: number }
  | { step: "pr_merged"; url: string; attempt: number }
  | { step: "pr_failed"; url: string; attempt: number }
  | { step: "shipped"; releaseUrl?: string }
  | { step: "complete" };

/**
 * Render a milestone as the entry a linked issue receives. Only the fields
 * named in `Milestone` can appear, which is what keeps free text out.
 */
export function milestoneEntry(
  milestone: Milestone,
  primaryIssueNumber: number,
): LifecycleEntryParams {
  const via = `via #${primaryIssueNumber}`;
  const base = { isVerbose: false };
  switch (milestone.step) {
    case "implementation_started":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "in_progress",
        summary: `Implementation started ${via}`,
        emoji: "\u{1F680}",
        payload: { primaryIssueNumber },
      };
    case "verification_passed":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "in_progress",
        summary: `Verification passed ${via} for ${milestone.commit}`,
        emoji: "\u{2705}",
        payload: { primaryIssueNumber, commit: milestone.commit },
      };
    case "attestation_posted":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "in_progress",
        summary: `Verification attestation posted ${via}`,
        emoji: "\u{1F4DC}",
        payload: {
          primaryIssueNumber,
          attestationId: milestone.attestationId,
          commit: milestone.commit,
        },
      };
    case "pr_linked":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "in_progress",
        summary: `PR linked ${via}: ${milestone.url}`,
        emoji: "\u{1F517}",
        payload: {
          primaryIssueNumber,
          url: milestone.url,
          attempt: milestone.attempt,
        },
      };
    case "pr_merged":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "in_progress",
        summary: `PR merged ${via}: ${milestone.url} — awaiting release`,
        emoji: "\u{1F389}",
        payload: {
          primaryIssueNumber,
          url: milestone.url,
          attempt: milestone.attempt,
        },
      };
    case "pr_failed":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "in_progress",
        summary: `PR failed ${via} — work continues there`,
        emoji: "\u{274C}",
        payload: {
          primaryIssueNumber,
          url: milestone.url,
          attempt: milestone.attempt,
        },
      };
    case "shipped":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "shipped",
        summary: milestone.releaseUrl
          ? `Shipped ${via}: ${milestone.releaseUrl}`
          : `Shipped ${via}`,
        emoji: "\u{1F680}",
        payload: milestone.releaseUrl
          ? { primaryIssueNumber, releaseUrl: milestone.releaseUrl }
          : { primaryIssueNumber },
      };
    case "complete":
      return {
        ...base,
        step: milestone.step,
        targetStatus: "shipped",
        summary: `Complete ${via}`,
        emoji: "\u{2705}",
        payload: { primaryIssueNumber },
      };
  }
}

/** Post a milestone on every linked issue, warning on each failure. */
export async function mirrorMilestone(
  sc: SwampClubClient | null,
  linked: LinkedIssueData[],
  primaryIssueNumber: number,
  milestone: Milestone,
  logger: RecorderLogger,
): Promise<void> {
  if (!sc) return;
  const entry = milestoneEntry(milestone, primaryIssueNumber);
  for (const issue of linked) {
    await recordLifecycleBestEffort(
      sc.forIssue(issue.issueNumber),
      logger,
      entry,
    );
  }
}
