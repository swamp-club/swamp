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

// status walks and PR links raise (idempotent, so a re-run converges); mirrored
// posts are best-effort since a post cannot be undone; mirrors carry only
// structured fields, not the primary's title or text

import type { ForwardStatus } from "./issue_status.ts";
import type { LinkedIssueData, LinkedIssuesData } from "./schemas.ts";
import type { LifecycleEntryParams, SwampClubClient } from "./swamp_club.ts";
import {
  type RecorderLogger,
  recordLifecycleBestEffort,
  recordUpstreamChange,
} from "./lifecycle_recorder.ts";

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

export type Milestone =
  | { step: "implementation_started" }
  | { step: "verification_passed"; commit: string }
  | { step: "attestation_posted"; attestationId: string; commit: string }
  | { step: "pr_linked"; url: string; attempt: number }
  | { step: "pr_merged"; url: string; attempt: number }
  | { step: "pr_failed"; url: string; attempt: number }
  | { step: "complete" };

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
        targetStatus: "shipped",
        summary: `PR merged ${via}: ${milestone.url} — shipped`,
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
