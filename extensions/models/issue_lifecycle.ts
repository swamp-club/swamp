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
import {
  AdversarialFindingSchema,
  type AdversarialReviewData,
  AdversarialReviewSchema,
  AttestationSchema,
  ClassificationSchema,
  type CodeConformanceReviewData,
  CodeConformanceReviewSchema,
  ContextSchema,
  type DuplicateData,
  DuplicateSchema,
  FeedbackSchema,
  GlobalArgsSchema,
  IssueType,
  type LinkedIssueData,
  LinkedIssuesSchema,
  LinkedOutcomeSchema,
  LinkRelationship,
  type PlanData,
  PlanSchema,
  PlanStepSchema,
  PR_COOLDOWN_MS,
  type PullRequestData,
  PullRequestSchema,
  type StateData,
  StateSchema,
  StepVerificationSchema,
  SummarySchema,
  TRANSITIONS,
  VerificationResultSchema,
} from "./_lib/schemas.ts";
import {
  createSwampClubClient,
  type EligibleAssignee,
  type FetchedIssue,
  loadAuthFile,
} from "./_lib/swamp_club.ts";
import {
  recordLifecycle,
  recordLifecycleBestEffort,
  recordRipple,
  recordRippleBestEffort,
  recordUpstreamChange,
} from "./_lib/lifecycle_recorder.ts";
import {
  advanceLinked,
  linkPrOnLinked,
  mirrorMilestone,
  readLinkedIssues,
} from "./_lib/linked_issues.ts";
import { upstreamStatusForPhase } from "./_lib/issue_status.ts";
import type { SwampClubClient } from "./_lib/swamp_club.ts";

/** Global args type for the issue-lifecycle model. */
type GlobalArgs = {
  issueNumber: number;
  swampClubUrl?: string;
  swampClubApiKey?: string;
};

/** Read the current state from data repository (for checks). */
async function readState(
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
    ) => Promise<Uint8Array | null>;
  },
  modelType: string,
  modelId: string,
): Promise<StateData | null> {
  const content = await dataRepository.getContent(
    modelType,
    modelId,
    "state-main",
  );
  if (!content) return null;
  return JSON.parse(new TextDecoder().decode(content)) as StateData;
}

export function buildNotifyMessage(
  author: string,
  prData: PullRequestData | null,
  planData: PlanData | null,
  duplicate?: DuplicateData | null,
): string {
  if (duplicate) {
    const prText = duplicate.canonicalPrUrl
      ? ` ([PR](${duplicate.canonicalPrUrl}))`
      : "";
    return (
      `Thanks @${author} for reporting this! It turned out to be the same ` +
      `problem as #${duplicate.canonicalIssueNumber}, which has been ` +
      `fixed${prText} and shipped. We appreciate your contribution to swamp.`
    );
  }

  const mergedText = prData?.url ? `[merged](${prData.url})` : "merged";

  const summaryText = planData?.summary
    ? ` We shipped: ${planData.summary}.`
    : "";

  return (
    `Thanks @${author} for reporting this!${summaryText} ` +
    `The fix has been ${mergedText} and a release is on its way. ` +
    `We appreciate your contribution to swamp.`
  );
}

/**
 * Whether the issue author is on swamp-club's team roster. Both sides are
 * swamp-club identities, so the handle is a sound fallback when the server
 * omits the user id — unlike a GitHub login, which is a different namespace.
 */
function isTeamMember(
  issue: Pick<FetchedIssue, "author" | "authorId">,
  roster: EligibleAssignee[],
): boolean {
  return roster.some((member) =>
    issue.authorId
      ? member.userId === issue.authorId
      : member.username === issue.author
  );
}

/** Explain why notify posted nothing and how the operator can proceed. */
function notifyUndecided(reason: string): Error {
  return new Error(
    `${reason}, so no thank-you was posted and the phase is still notify. ` +
      "Re-run notify, pass --input force=true to thank the author anyway, " +
      "or run skip_notify.",
  );
}

/** A client for this lifecycle's issue, or an error saying why there is none. */
async function requireSwampClub(context: {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warning: (msg: string, props: Record<string, unknown>) => void;
  };
}): Promise<SwampClubClient> {
  const sc = await createSwampClubClient(context.globalArgs, context.logger);
  if (!sc) {
    throw new Error(
      "swamp-club is not reachable or credentials are missing. " +
        "Set SWAMP_API_KEY or run `swamp auth login`.",
    );
  }
  return sc;
}

/** Whether `value` parses as an http or https URL. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A security fix must not be announced on a public issue before it ships,
 * and a public issue must not be tracked under one whose milestones its
 * reader cannot see — so a security issue is only ever carried with another
 * security issue. Returns the refusal, or null when the pair is allowed.
 */
function securityParityError(
  primary: { number: number; type: string },
  linked: { number: number; type: string },
): string | null {
  if ((primary.type === "security") === (linked.type === "security")) {
    return null;
  }
  return `Issue #${primary.number} is ${primary.type} and #${linked.number} ` +
    `is ${linked.type}. A security issue can only be linked to another ` +
    `security issue.`;
}

/**
 * Refuse a type change on the primary that would break security parity
 * with an issue it already carries. `link_issue` checks the pair when it is
 * formed; this covers the primary's type changing afterwards, in `triage`
 * or `fast_forward`. Runs before any upstream write.
 */
async function assertLinkedParity(
  sc: SwampClubClient,
  primary: { number: number; type: string },
  linked: LinkedIssueData[],
): Promise<void> {
  for (const entry of linked) {
    const issue = await sc.forIssue(entry.issueNumber).fetchIssue();
    if (!issue) {
      throw new Error(
        `Could not fetch linked issue #${entry.issueNumber} to check it can ` +
          `stay linked to a ${primary.type} issue.`,
      );
    }
    const refusal = securityParityError(primary, {
      number: issue.number,
      type: issue.type,
    });
    if (refusal) {
      throw new Error(
        `${refusal} Unlink #${entry.issueNumber} with unlink_issue before ` +
          `making #${primary.number} ${primary.type}.`,
      );
    }
  }
}

/**
 * Warn when the issue about to be linked is already related to another
 * issue that has not shipped: another lifecycle may be carrying it. A
 * warning, not a refusal — status walks only move forward, so a second
 * carrier's transitions are no-ops, and `related_to` is also used by hand.
 */
async function warnIfCarriedElsewhere(
  sc: SwampClubClient,
  issue: FetchedIssue,
  primary: number,
  logger: { warning: (msg: string, props: Record<string, unknown>) => void },
): Promise<void> {
  for (const r of issue.relationships) {
    if (r.type !== "related_to" && r.type !== "duplicate_of") continue;
    if (r.otherIssueNumber === primary) continue;
    const other = await sc.forIssue(r.otherIssueNumber).fetchIssue();
    if (!other || other.status === "shipped" || other.status === "closed") {
      continue;
    }
    logger.warning(
      "#{issue} is already {type} #{other}, which is {status}; another " +
        "lifecycle may be carrying it",
      {
        issue: issue.number,
        type: r.type,
        other: r.otherIssueNumber,
        status: other.status,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@swamp/issue-lifecycle",
  version: "2026.10.07.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.03.26.1",
      description:
        "Add adversarial review resource, methods, and approval gate — no globalArguments changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.04.06.1",
      description:
        "Remove default repo, relax adversarial category from enum to string for cross-repo reuse",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.04.08.1",
      description:
        "Drop GitHub integration — swamp-club is now the source of truth. " +
        "Global args replaced (repo removed, issueNumber now refers to swamp-club lab issue). " +
        "Removed ci_status, record_pr, fix methods and ciResults/fixDirective resources.",
      upgradeAttributes: (old: Record<string, unknown>) => {
        const next = { ...old };
        delete next.repo;
        return next;
      },
    },
    {
      toVersion: "2026.04.08.2",
      description:
        "Add pr_open phase, pullRequest resource, and link_pr method. " +
        "Restores PR linkage dropped in 2026.04.08.1 without re-introducing git-host coupling — " +
        "the model persists whatever PR URL the agent supplies. " +
        "complete now accepts pr_open as a valid source phase alongside implementing.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.04.09.1",
      description: "Add post-PR lifecycle phases: pr_failed, releasing. " +
        "New methods: pr_merged (pr_open → releasing), pr_failed (pr_open → pr_failed), " +
        "ship (releasing → done). " +
        "New check: pr-cooldown enforces 3-minute wait after link_pr before status checks. " +
        "link_pr now accepts pr_failed as source phase for recovery. " +
        "implement now accepts pr_failed for rework scenarios. " +
        "complete now accepts releasing for backwards compatibility.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.04.12.1",
      description:
        "Auto-assign issue to the authenticated user during start(). " +
        "Reads username from local auth, resolves userId via the " +
        "eligible-assignees endpoint, and PATCHes the issue's assignees. " +
        "Best-effort — assignment failures are warnings, never errors.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.05.21.1",
      description: "Add notify phase for external contributors. " +
        "ship() and complete() now transition to notify instead of done. " +
        "New notify method posts a thank-you ripple and transitions to done. " +
        "Issue data now includes author field.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.06.18.1",
      description: "Add regressionIntroducedIn to triage classification — " +
        "captures the version that introduced a regression for time-to-detection metrics. " +
        "No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.06.29.1",
      description:
        "Add code conformance review — adversarial comparison of implemented code " +
        "against the approved plan. New codeConformanceReview resource, " +
        "code_conformance_review and justify_deviations methods, " +
        "code-conformance-clear check gating link_pr. " +
        "No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.05.1",
      description:
        "Truncate lifecycle entry summaries to 2000 chars in postLifecycleEntry " +
        "to prevent silent 400 rejections from the swamp-club API. " +
        "No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.30.1",
      description:
        "Adversarial regression verification — triage now requires evidence, " +
        "counter-evidence, and a verdict when isRegression is true. " +
        "Session summary — new summarizing phase between notify and done; " +
        "notify/skip_notify transition to summarizing, new summarize method " +
        "records problem/outcome before closing. No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.16.1",
      description: "Change Swamp Club API Health Endpoint",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.1",
      description:
        "Pre-PR verification loop — new verifying phase between implementing " +
        "and pr_open. Three new methods: verify (start verification), " +
        "verification_passed (record results as checklist), " +
        "verification_failed (return to implementing). " +
        "New verificationResult resource stores the checklist data. " +
        "No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description:
        "Add post_attestation method — posts verification attestation to " +
        "swamp-club before opening a PR. New TRANSITIONS entry for " +
        "post_attestation from verifying phase. No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.31.1",
      description:
        "Add fast_forward method for ad-hoc work that has no linked issue. " +
        "Atomically writes classification, plan, adversarial review, and " +
        "code conformance review, then transitions to implementing. " +
        "Allows retroactive lifecycle creation for work already done. " +
        "No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.1",
      description:
        "Stop swallowing dropped swamp-club writes. postLifecycleEntry, " +
        "patchIssue and submitComment now report an outcome, and a " +
        "lifecycle_recorder policy module raises when a mandatory audit " +
        "record is not written, so a method no longer reports success over a " +
        "lost entry. transitionStatus confirms an already-applied transition " +
        "by re-reading the issue status rather than matching server prose. " +
        "Methods declare rollbackOnFailure so a raised failure leaves the " +
        "phase unchanged; notify and post_attestation are excluded because " +
        "their upstream side effects are not idempotent. No globalArguments " +
        "changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.21.1",
      description:
        "Fix two ordering deadlocks. fast_forward now allowed from " +
        "classified (not just triaging) and transitions upstream through " +
        "triaged before in_progress. verify now requires a code conformance " +
        "review to exist (conformance-review-required check) so the ordering " +
        "mistake is caught early instead of discovered at link_pr. " +
        "resolve_findings now also allowed from approved. " +
        "No globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.22.1",
      description:
        "post_attestation validates its input against AttestationSchema " +
        "instead of posting whatever parsed as JSON. The document's shape " +
        "was previously enforced only by jq in CI, after the PR was public, " +
        "so an attestation missing `subject` posted cleanly and logged " +
        "commit=undefined. It is rejected at the boundary now; build the " +
        "document with `deno run build-attestation` rather than by hand. " +
        "No resources and no globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.23.1",
      description:
        "verify's description no longer mentions a container sandbox; " +
        "verification runs as host workflows. Description-only change. " +
        "No resources and no globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.23.2",
      description:
        "notify decides for itself whether to thank the author. It checks " +
        "the author's swamp-club user id against the eligible-assignees " +
        "roster and skips team members, instead of relying on the skill's " +
        "comparison of swamp-club handles with GitHub logins, which read " +
        "every team member as external. When the issue or roster lookup " +
        "fails it posts nothing and leaves the phase at notify. New force " +
        "argument bypasses the roster check. No resources and no " +
        "globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.29.1",
      description:
        "One lifecycle can carry several issues. New link_issue and " +
        "unlink_issue methods and a linkedIssues resource: linked issues " +
        "follow the primary's swamp-club status, receive its milestones as " +
        "fixed-text entries, get the PR, and are covered by notify and " +
        "summarize (new linkedOutcomes input). New mark_duplicate method and " +
        "duplicate resource ship a duplicate of an already-shipped issue " +
        "with that issue's PR instead of closing it. link_pr now records " +
        "the PR on the swamp-club issue itself. No globalArguments changes; " +
        "both new resources are optional, so existing instances need no " +
        "migration.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.07.1",
      description:
        "AttestationSchema accepts an optional affectedCommands object, the " +
        "CLI commands a change can affect. post_attestation validates it " +
        "when present and posts it with the rest of the document. No " +
        "globalArguments changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    "state": {
      description: "Current lifecycle phase and metadata",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "context": {
      description: "Issue context fetched from swamp-club",
      schema: ContextSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "classification": {
      description: "Issue triage classification",
      schema: ClassificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "plan": {
      description: "Implementation plan (versioned across iterations)",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "feedback": {
      description: "Human feedback on plan (versioned per round)",
      schema: FeedbackSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "adversarialReview": {
      description: "Adversarial review findings for the current plan version",
      schema: AdversarialReviewSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "codeConformanceReview": {
      description:
        "Adversarial comparison of implemented code against the approved plan. " +
        "Records per-step verification status and justifications for deviations. " +
        "Gates link_pr — all deviations must be justified before a PR can be linked.",
      schema: CodeConformanceReviewSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "verificationResult": {
      description:
        "Verification workflow result — the full checklist of steps, " +
        "their statuses, and the gate outcome. Written by verification_passed " +
        "and used as a gate on link_pr.",
      schema: VerificationResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "pullRequest": {
      description:
        "Pull request linked to the implementation. Single instance, " +
        "overwritten by subsequent link_pr calls so the record always " +
        "reflects the latest link.",
      schema: PullRequestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "linkedIssues": {
      description:
        "Issues this lifecycle carries alongside its own, written by " +
        "link_issue and unlink_issue. They follow the primary's status and " +
        "are covered by notify and summarize.",
      schema: LinkedIssuesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "duplicate": {
      description:
        "The shipped issue this one duplicates and the PR that fixed it, " +
        "written by mark_duplicate.",
      schema: DuplicateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description:
        "Session summary restating the original problem and delivered outcome. " +
        "Written at the end of the lifecycle to verify the work addressed the issue.",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  checks: {
    "valid-transition": {
      description:
        "Validates that the method is allowed from the current lifecycle phase",
      labels: ["policy"],
      execute: async (context: {
        methodName: string;
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const allowed = TRANSITIONS[context.methodName];
        if (!allowed) return { pass: true };

        const state = await readState(
          context.dataRepository,
          context.modelType,
          context.modelId,
        );

        if (!state) {
          return context.methodName === "start" ? { pass: true } : {
            pass: false,
            errors: ["No lifecycle state found. Run 'start' first."],
          };
        }

        if (!allowed.includes(state.phase)) {
          return {
            pass: false,
            errors: [
              `Method '${context.methodName}' cannot run in phase '${state.phase}'. ` +
              `Allowed phases: ${allowed.join(", ")}`,
            ],
          };
        }
        return { pass: true };
      },
    },

    "plan-exists": {
      description: "Ensures a plan exists before approve can be called",
      labels: ["policy"],
      appliesTo: ["approve"],
      execute: async (context: {
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "plan-main",
        );
        if (!content) {
          return {
            pass: false,
            errors: ["No plan exists. Generate a plan first."],
          };
        }
        return { pass: true };
      },
    },

    "plan-approved": {
      description: "Ensures plan is approved before implement can be called",
      labels: ["policy"],
      appliesTo: ["implement"],
      execute: async (context: {
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const state = await readState(
          context.dataRepository,
          context.modelType,
          context.modelId,
        );
        if (!state) {
          return { pass: false, errors: ["No state found."] };
        }
        if (state.phase !== "approved" && state.phase !== "pr_failed") {
          return {
            pass: false,
            errors: [
              "Plan must be approved (or PR must have failed) before implementation can begin.",
            ],
          };
        }
        return { pass: true };
      },
    },

    "pr-cooldown": {
      description:
        "Enforces a minimum cooldown after link_pr before the PR status can be " +
        "reported, giving CI time to run",
      labels: ["policy"],
      appliesTo: ["pr_merged", "pr_failed"],
      execute: async (context: {
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "pullRequest-main",
        );
        if (!content) {
          return {
            pass: false,
            errors: ["No pull request linked. Call link_pr first."],
          };
        }
        const pr = JSON.parse(
          new TextDecoder().decode(content),
        ) as PullRequestData;
        const linkedAt = new Date(pr.linkedAt).getTime();
        const now = Date.now();
        const elapsed = now - linkedAt;
        if (elapsed < PR_COOLDOWN_MS) {
          const remaining = Math.ceil((PR_COOLDOWN_MS - elapsed) / 1000);
          return {
            pass: false,
            errors: [
              `PR was linked ${Math.floor(elapsed / 1000)}s ago. ` +
              `Wait ${remaining}s more before checking PR status (3-minute cooldown for CI).`,
            ],
          };
        }
        return { pass: true };
      },
    },

    "code-conformance-clear": {
      description:
        "Ensures all code-vs-plan deviations are justified before a PR can be linked",
      labels: ["policy"],
      appliesTo: ["link_pr", "complete"],
      execute: async (context: {
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const planContent = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "plan-main",
        );
        if (!planContent) {
          return { pass: false, errors: ["No plan exists."] };
        }
        const plan = JSON.parse(
          new TextDecoder().decode(planContent),
        ) as PlanData;

        const reviewContent = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "codeConformanceReview-main",
        );
        if (!reviewContent) {
          return {
            pass: false,
            errors: [
              "No code conformance review exists. Run 'code_conformance_review' before linking a PR.",
            ],
          };
        }
        const review = JSON.parse(
          new TextDecoder().decode(reviewContent),
        ) as CodeConformanceReviewData;

        if (review.planVersion !== plan.version) {
          return {
            pass: false,
            errors: [
              `Code conformance review is for plan v${review.planVersion} but current plan is v${plan.version}. Re-run 'code_conformance_review'.`,
            ],
          };
        }

        const unjustified = review.steps.filter(
          (s) => s.status !== "implemented" && !s.justification,
        );

        if (unjustified.length > 0) {
          const orders = unjustified.map((s) => `step ${s.order}`).join(", ");
          return {
            pass: false,
            errors: [
              `${unjustified.length} unjustified deviation(s): ${orders}. Run 'justify_deviations' to explain why the code differs from the plan.`,
            ],
          };
        }

        return { pass: true };
      },
    },

    "verification-clear": {
      description: "Ensures verification passed before a PR can be linked",
      labels: ["policy"],
      appliesTo: ["link_pr"],
      execute: async (context: {
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "verificationResult-main",
        );
        if (!content) {
          return {
            pass: false,
            errors: [
              "No verification result exists. Run 'verify' and then 'verification_passed' before linking a PR.",
            ],
          };
        }

        const result = JSON.parse(
          new TextDecoder().decode(content),
        ) as { allPassed: boolean; stepsFailed: number };

        if (!result.allPassed) {
          return {
            pass: false,
            errors: [
              `Verification failed (${result.stepsFailed} step(s) failed). Fix the issues and re-verify.`,
            ],
          };
        }

        return { pass: true };
      },
    },

    "adversarial-review-clear": {
      description:
        "Ensures all critical/high adversarial findings are resolved before approval",
      labels: ["policy"],
      appliesTo: ["approve"],
      execute: async (context: {
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const planContent = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "plan-main",
        );
        if (!planContent) {
          return { pass: false, errors: ["No plan exists."] };
        }
        const plan = JSON.parse(
          new TextDecoder().decode(planContent),
        ) as PlanData;

        const reviewContent = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "adversarialReview-main",
        );
        if (!reviewContent) {
          return {
            pass: false,
            errors: [
              "No adversarial review exists. Run 'adversarial_review' before approving.",
            ],
          };
        }
        const review = JSON.parse(
          new TextDecoder().decode(reviewContent),
        ) as AdversarialReviewData;

        if (review.planVersion !== plan.version) {
          return {
            pass: false,
            errors: [
              `Adversarial review is for plan v${review.planVersion} but current plan is v${plan.version}. Re-run 'adversarial_review'.`,
            ],
          };
        }

        const unresolved = review.findings.filter(
          (f) =>
            !f.resolved &&
            (f.severity === "critical" || f.severity === "high"),
        );

        if (unresolved.length > 0) {
          const ids = unresolved.map((f) => f.id).join(", ");
          return {
            pass: false,
            errors: [
              `${unresolved.length} unresolved critical/high finding(s): ${ids}. Resolve these before approving.`,
            ],
          };
        }

        return { pass: true };
      },
    },

    "conformance-review-required": {
      description:
        "Ensures a code conformance review exists before verification can start, " +
        "preventing a deadlock where verify moves to verifying but link_pr " +
        "demands a conformance review that can no longer be created",
      labels: ["policy"],
      appliesTo: ["verify"],
      execute: async (context: {
        dataRepository: {
          getContent: (
            type: string,
            modelId: string,
            dataName: string,
          ) => Promise<Uint8Array | null>;
        };
        modelType: string;
        modelId: string;
      }) => {
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "codeConformanceReview-main",
        );
        if (!content) {
          return {
            pass: false,
            errors: [
              "No code conformance review exists. Run 'code_conformance_review' before 'verify' — " +
              "once in the verifying phase, the conformance review can no longer be created.",
            ],
          };
        }
        return { pass: true };
      },
    },
  },

  methods: {
    start: {
      rollbackOnFailure: true,
      description: "Ensure the swamp-club issue exists and begin the lifecycle",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const handles = [];

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (!sc) {
          throw new Error(
            "swamp-club is not reachable or credentials are missing. " +
              "Set SWAMP_API_KEY or run `swamp auth login`.",
          );
        }

        const issue = await sc.fetchIssue();
        if (!issue) {
          throw new Error(
            `swamp-club issue #${issueNumber} was not found. ` +
              `Create the issue in swamp-club first, then run 'start'.`,
          );
        }

        handles.push(
          await context.writeResource("context", "context-main", {
            title: issue.title,
            body: issue.body,
            type: issue.type,
            status: issue.status,
            author: issue.author,
            comments: issue.comments,
            fetchedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "triaging",
            issueNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info(
          "Fetched swamp-club issue #{issueNumber}: {title}",
          {
            issueNumber,
            title: issue.title,
          },
        );

        await recordLifecycle(sc, {
          step: "triage_started",
          targetStatus: "open",
          summary: "Triage started",
          emoji: "\u{1F50D}",
          payload: { issueNumber },
          isVerbose: false,
        });

        // Auto-assign the issue to the current authenticated user.
        // All failures are warnings — assignment must never break the triage flow.
        const authFile = await loadAuthFile();
        const authUsername = authFile?.username;
        if (!authUsername) {
          context.logger.warning(
            "Cannot determine your username — issue will not be auto-assigned. " +
              "Run `swamp auth login` to enable auto-assignment.",
            {},
          );
        } else {
          const resolvedUserId = await sc.resolveUserId(authUsername);
          if (!resolvedUserId) {
            context.logger.warning(
              "Could not resolve your swamp-club identity — issue will not be auto-assigned.",
              {},
            );
          } else {
            const existingIds = issue.assignees.map((a) => a.userId);
            if (existingIds.includes(resolvedUserId)) {
              context.logger.info(
                "Already assigned to {username}",
                { username: authUsername },
              );
            } else {
              await sc.updateAssignees([...existingIds, resolvedUserId]);
              // Best-effort: this entry reports on the assignment above,
              // which is itself best-effort. Raising here would break the
              // triage flow this block promises never to break.
              await recordLifecycleBestEffort(sc, context.logger, {
                step: "assigned",
                targetStatus: "open",
                summary: `Assigned to ${authUsername}`,
                emoji: "\u{1F464}",
                payload: { username: authUsername, userId: resolvedUserId },
                isVerbose: false,
              });
              context.logger.info(
                "Auto-assigned issue to {username}",
                { username: authUsername },
              );
            }
          }
        }

        return { dataHandles: handles };
      },
    },

    triage: {
      rollbackOnFailure: true,
      description: "Classify the issue based on context",
      arguments: z.object({
        type: IssueType,
        confidence: z.enum(["high", "medium", "low"]),
        reasoning: z.string(),
        isRegression: z.boolean().optional().describe(
          "True if this is a regression (something that previously worked). Implies type=bug.",
        ),
        regressionIntroducedIn: z.string().optional().describe(
          "Version that introduced the regression (e.g. '2026.06.12.1'). Only set when isRegression is true.",
        ),
        regressionEvidence: z.string().optional().describe(
          "Concrete evidence that this previously worked (commit hash, version, test output). " +
            "Required when isRegression is true.",
        ),
        regressionCounterEvidence: z.string().optional().describe(
          "The strongest argument that this is NOT a regression. " +
            "Required when isRegression is true.",
        ),
        regressionVerdict: z.enum(["confirmed", "downgraded"]).optional()
          .describe(
            "Final verdict after weighing evidence and counter-evidence. " +
              "Required when isRegression is true.",
          ),
        regressionVerdictReasoning: z.string().optional().describe(
          "Why the verdict stands despite the counter-evidence. " +
            "Required when isRegression is true.",
        ),
        clarifyingQuestions: z.array(z.string()).optional(),
      }),
      execute: async (
        args: {
          type: "bug" | "feature" | "platform" | "security";
          confidence: "high" | "medium" | "low";
          reasoning: string;
          isRegression?: boolean;
          regressionIntroducedIn?: string;
          regressionEvidence?: string;
          regressionCounterEvidence?: string;
          regressionVerdict?: "confirmed" | "downgraded";
          regressionVerdictReasoning?: string;
          clarifyingQuestions?: string[];
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const handles = [];

        let effectiveIsRegression = args.isRegression;
        let effectiveRegressionIntroducedIn = args.regressionIntroducedIn;

        if (args.isRegression) {
          if (
            !args.regressionEvidence ||
            !args.regressionCounterEvidence ||
            !args.regressionVerdict ||
            !args.regressionVerdictReasoning
          ) {
            throw new Error(
              "Regression classification requires adversarial verification: " +
                "regressionEvidence, regressionCounterEvidence, regressionVerdict, " +
                "and regressionVerdictReasoning are all required when isRegression is true.",
            );
          }

          if (args.regressionVerdict === "downgraded") {
            effectiveIsRegression = false;
            effectiveRegressionIntroducedIn = undefined;
            context.logger.info(
              "Regression downgraded to plain bug after adversarial review: {reasoning}",
              { reasoning: args.regressionVerdictReasoning },
            );
          }
        }

        handles.push(
          await context.writeResource(
            "classification",
            "classification-main",
            {
              type: args.type,
              confidence: args.confidence,
              reasoning: args.reasoning,
              isRegression: effectiveIsRegression,
              regressionIntroducedIn: effectiveRegressionIntroducedIn,
              regressionEvidence: args.regressionEvidence,
              regressionCounterEvidence: args.regressionCounterEvidence,
              regressionVerdict: args.regressionVerdict,
              regressionVerdictReasoning: args.regressionVerdictReasoning,
              clarifyingQuestions: args.clarifyingQuestions,
              classifiedAt: new Date().toISOString(),
            },
          ),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "classified",
            issueNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        const regressionLabel = effectiveIsRegression ? " (regression)" : "";
        context.logger.info(
          "Classified as {type}{regression} ({confidence}): {reasoning}",
          {
            type: args.type,
            regression: regressionLabel,
            confidence: args.confidence,
            reasoning: args.reasoning,
          },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc) {
          const linked = await readLinkedIssues(context.readResource);
          await assertLinkedParity(
            sc,
            { number: issueNumber, type: args.type },
            linked,
          );
          // The entry post is the last fatal upstream action in this method:
          // rollback reverts the local write but cannot unsend an entry, so
          // anything that can raise must run before it or a re-run would post
          // the entry twice.
          recordUpstreamChange(
            context.logger,
            "issue type update",
            await sc.updateType(args.type),
          );
          recordUpstreamChange(
            context.logger,
            "status transition to triaged",
            await sc.transitionStatus("triaged"),
          );
          await advanceLinked(sc, linked, "triaged", context.logger);
          await recordLifecycle(sc, {
            step: "classified",
            targetStatus: "triaged",
            summary:
              `Classified as ${args.type}${regressionLabel} (${args.confidence})`,
            emoji: "\u{1F4CB}",
            payload: {
              type: args.type,
              confidence: args.confidence,
              reasoning: args.reasoning,
              isRegression: effectiveIsRegression ?? false,
              regressionIntroducedIn: effectiveRegressionIntroducedIn,
              regressionEvidence: args.regressionEvidence,
              regressionCounterEvidence: args.regressionCounterEvidence,
              regressionVerdict: args.regressionVerdict,
              regressionVerdictReasoning: args.regressionVerdictReasoning,
              clarifyingQuestions: args.clarifyingQuestions,
            },
            isVerbose: false,
          });
        }

        return { dataHandles: handles };
      },
    },

    plan: {
      rollbackOnFailure: true,
      description: "Generate an initial implementation plan",
      arguments: z.object({
        summary: z.string(),
        dddAnalysis: z.string(),
        steps: z.array(PlanStepSchema),
        testingStrategy: z.string(),
        potentialChallenges: z.array(z.string()),
      }),
      execute: async (
        args: {
          summary: string;
          dddAnalysis: string;
          steps: {
            order: number;
            description: string;
            files: string[];
            risks?: string;
          }[];
          testingStrategy: string;
          potentialChallenges: string[];
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const handles = [];

        handles.push(
          await context.writeResource("plan", "plan-main", {
            version: 1,
            summary: args.summary,
            dddAnalysis: args.dddAnalysis,
            steps: args.steps,
            testingStrategy: args.testingStrategy,
            potentialChallenges: args.potentialChallenges,
            feedbackIncorporated: [],
            generatedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "plan_generated",
            issueNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info("Plan v1 generated: {summary}", {
          summary: args.summary,
        });

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "plan_generated",
          targetStatus: "triaged",
          summary: `Implementation plan generated (v1) \u2014 ${args.summary}`,
          emoji: "\u{1F4DD}",
          payload: {
            version: 1,
            summary: args.summary,
            dddAnalysis: args.dddAnalysis,
            steps: args.steps,
            testingStrategy: args.testingStrategy,
            potentialChallenges: args.potentialChallenges,
          },
          isVerbose: true,
        });

        return { dataHandles: handles };
      },
    },

    review: {
      description: "Display the current plan (read-only)",
      arguments: z.object({
        version: z.number().optional().describe(
          "Specific plan version to review",
        ),
      }),
      execute: async (
        args: { version?: number },
        context: {
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const plan = await context.readResource!("plan-main", args.version) as
          | PlanData
          | null;
        if (!plan) throw new Error("No plan exists yet. Run 'plan' first.");

        const stepsText = plan.steps.map((s) =>
          `  ${s.order}. ${s.description}`
        ).join("\n");
        context.logger.info(
          "Plan v{version}:\n{summary}\n\nSteps:\n{steps}\n\nTesting: {testing}",
          {
            version: plan.version,
            summary: plan.summary,
            steps: stepsText,
            testing: plan.testingStrategy,
          },
        );

        return { dataHandles: [] };
      },
    },

    iterate: {
      rollbackOnFailure: true,
      description:
        "Submit feedback and a revised plan incorporating all prior feedback",
      arguments: z.object({
        feedback: z.string().describe("Human feedback on the current plan"),
        summary: z.string(),
        dddAnalysis: z.string(),
        steps: z.array(PlanStepSchema),
        testingStrategy: z.string(),
        potentialChallenges: z.array(z.string()),
      }),
      execute: async (
        args: {
          feedback: string;
          summary: string;
          dddAnalysis: string;
          steps: {
            order: number;
            description: string;
            files: string[];
            risks?: string;
          }[];
          testingStrategy: string;
          potentialChallenges: string[];
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          dataRepository: {
            findAllForModel: (
              type: string,
              modelId: string,
            ) => Promise<{ name: string; version: number }[]>;
            getContent: (
              type: string,
              modelId: string,
              dataName: string,
              version?: number,
            ) => Promise<Uint8Array | null>;
          };
          modelType: string;
          modelId: string;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const handles = [];

        const currentPlan = await context.readResource!("plan-main") as
          | PlanData
          | null;
        const currentVersion = currentPlan ? currentPlan.version : 0;

        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        const feedbackEntries = allData.filter((d) =>
          d.name === "feedback-main"
        );
        const feedbackRound = feedbackEntries.length + 1;

        const allFeedback: string[] = [];
        for (const entry of feedbackEntries) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            "feedback-main",
            entry.version,
          );
          if (content) {
            const fb = JSON.parse(new TextDecoder().decode(content));
            allFeedback.push(fb.feedback as string);
          }
        }
        allFeedback.push(args.feedback);

        handles.push(
          await context.writeResource("feedback", "feedback-main", {
            round: feedbackRound,
            feedback: args.feedback,
            planVersionReviewed: currentVersion,
            submittedAt: new Date().toISOString(),
          }),
        );

        const newVersion = currentVersion + 1;
        handles.push(
          await context.writeResource("plan", "plan-main", {
            version: newVersion,
            summary: args.summary,
            dddAnalysis: args.dddAnalysis,
            steps: args.steps,
            testingStrategy: args.testingStrategy,
            potentialChallenges: args.potentialChallenges,
            feedbackIncorporated: allFeedback,
            generatedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "plan_generated",
            issueNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info(
          "Plan revised to v{version}, incorporated feedback round {round}",
          { version: newVersion, round: feedbackRound },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "plan_revised",
          targetStatus: "triaged",
          summary:
            `Plan revised (v${newVersion}) \u2014 feedback round ${feedbackRound}`,
          emoji: "\u{1F504}",
          payload: {
            version: newVersion,
            feedbackRound,
            feedback: args.feedback,
            summary: args.summary,
            steps: args.steps,
            testingStrategy: args.testingStrategy,
            potentialChallenges: args.potentialChallenges,
          },
          isVerbose: true,
        });

        return { dataHandles: handles };
      },
    },

    adversarial_review: {
      rollbackOnFailure: true,
      description:
        "Record adversarial review findings for the current plan version",
      arguments: z.object({
        findings: z.array(AdversarialFindingSchema),
      }),
      execute: async (
        args: {
          findings: {
            id: string;
            severity: "critical" | "high" | "medium" | "low";
            category: string;
            description: string;
            resolved?: boolean;
            resolutionNote?: string;
          }[];
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const handles = [];

        const plan = await context.readResource!("plan-main") as
          | PlanData
          | null;
        const planVersion = plan ? plan.version : 0;

        const findings = args.findings.map((f) => ({
          ...f,
          resolved: f.resolved ?? false,
        }));

        handles.push(
          await context.writeResource(
            "adversarialReview",
            "adversarialReview-main",
            {
              planVersion,
              findings,
              reviewedAt: new Date().toISOString(),
            },
          ),
        );

        const critical = findings.filter((f) => f.severity === "critical")
          .length;
        const high = findings.filter((f) => f.severity === "high").length;
        const medium = findings.filter((f) => f.severity === "medium").length;
        const low = findings.filter((f) => f.severity === "low").length;

        context.logger.info(
          "Adversarial review for plan v{planVersion}: {critical} critical, {high} high, {medium} medium, {low} low",
          { planVersion, critical, high, medium, low },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "adversarial_review",
          targetStatus: "triaged",
          summary:
            `Adversarial review (plan v${planVersion}): ${critical} critical, ${high} high`,
          emoji: "\u{1F50D}",
          payload: {
            planVersion,
            findings,
            critical,
            high,
            medium,
            low,
            blockers: critical + high,
          },
          isVerbose: true,
        });

        return { dataHandles: handles };
      },
    },

    resolve_findings: {
      rollbackOnFailure: true,
      description:
        "Mark adversarial review findings as resolved after plan revision",
      arguments: z.object({
        resolutions: z.array(z.object({
          findingId: z.string().describe("Finding ID to resolve, e.g. ADV-1"),
          resolutionNote: z.string().describe(
            "How this finding was addressed in the revised plan",
          ),
        })),
      }),
      execute: async (
        args: {
          resolutions: { findingId: string; resolutionNote: string }[];
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const handles = [];

        const current = await context.readResource!(
          "adversarialReview-main",
        ) as AdversarialReviewData | null;
        if (!current) {
          throw new Error(
            "No adversarial review exists. Run 'adversarial_review' first.",
          );
        }

        const resolutionMap = new Map(
          args.resolutions.map((r) => [r.findingId, r.resolutionNote]),
        );

        const updatedFindings = current.findings.map((f) => {
          const note = resolutionMap.get(f.id);
          if (note) {
            return { ...f, resolved: true, resolutionNote: note };
          }
          return f;
        });

        handles.push(
          await context.writeResource(
            "adversarialReview",
            "adversarialReview-main",
            {
              planVersion: current.planVersion,
              findings: updatedFindings,
              reviewedAt: new Date().toISOString(),
            },
          ),
        );

        const resolved = args.resolutions.length;
        const remaining = updatedFindings.filter(
          (f) =>
            !f.resolved &&
            (f.severity === "critical" || f.severity === "high"),
        ).length;

        context.logger.info(
          "Resolved {resolved} finding(s), {remaining} blocking finding(s) remain",
          { resolved, remaining },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "findings_resolved",
          targetStatus: "triaged",
          summary:
            `${resolved} finding(s) resolved, ${remaining} blocking remain`,
          emoji: "\u{2705}",
          payload: {
            resolved,
            remaining,
            resolutions: args.resolutions,
          },
          isVerbose: false,
        });

        return { dataHandles: handles };
      },
    },

    code_conformance_review: {
      rollbackOnFailure: true,
      description:
        "Record an adversarial comparison of implemented code against the approved plan. " +
        "Each plan step is verified as implemented, deviated, partially implemented, or missing. " +
        "Unplanned changes are recorded as 'added' steps. Deviations are expected — " +
        "they just need a justification explaining why the code differs.",
      arguments: z.object({
        steps: z.array(StepVerificationSchema).describe(
          "Per-step verification of plan conformance, plus entries for unplanned changes",
        ),
      }),
      execute: async (
        args: {
          steps: {
            order: number;
            status:
              | "implemented"
              | "deviated"
              | "partially_implemented"
              | "missing"
              | "added";
            description: string;
            justification?: string;
          }[];
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const handles = [];

        const plan = await context.readResource!("plan-main") as
          | PlanData
          | null;
        if (!plan) {
          throw new Error("No plan exists. Run 'plan' first.");
        }

        handles.push(
          await context.writeResource(
            "codeConformanceReview",
            "codeConformanceReview-main",
            {
              planVersion: plan.version,
              steps: args.steps,
              reviewedAt: new Date().toISOString(),
            },
          ),
        );

        const implemented =
          args.steps.filter((s) => s.status === "implemented").length;
        const deviated = args.steps.filter((s) => s.status !== "implemented")
          .length;
        const unjustified = args.steps.filter(
          (s) => s.status !== "implemented" && !s.justification,
        ).length;

        context.logger.info(
          "Code conformance review for plan v{planVersion}: {implemented} implemented, {deviated} deviated ({unjustified} unjustified)",
          {
            planVersion: plan.version,
            implemented,
            deviated,
            unjustified,
          },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "code_conformance_review",
          targetStatus: "in_progress",
          summary:
            `Code conformance review (plan v${plan.version}): ${implemented} implemented, ${deviated} deviated (${unjustified} unjustified)`,
          emoji: "\u{1F50D}",
          payload: {
            planVersion: plan.version,
            steps: args.steps,
            implemented,
            deviated,
            unjustified,
          },
          isVerbose: true,
        });

        return { dataHandles: handles };
      },
    },

    justify_deviations: {
      rollbackOnFailure: true,
      description:
        "Add justifications to code conformance review steps that deviate from the plan. " +
        "Deviations are expected — this method records why the code differs.",
      arguments: z.object({
        justifications: z.array(z.object({
          order: z.number().describe(
            "Step order number to justify",
          ),
          justification: z.string().describe(
            "Why the code differs from the plan for this step",
          ),
        })),
      }),
      execute: async (
        args: {
          justifications: { order: number; justification: string }[];
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const handles = [];

        const current = await context.readResource!(
          "codeConformanceReview-main",
        ) as CodeConformanceReviewData | null;
        if (!current) {
          throw new Error(
            "No code conformance review exists. Run 'code_conformance_review' first.",
          );
        }

        const justificationMap = new Map(
          args.justifications.map((j) => [j.order, j.justification]),
        );

        const updatedSteps = current.steps.map((s) => {
          const justification = justificationMap.get(s.order);
          if (justification) {
            return { ...s, justification };
          }
          return s;
        });

        handles.push(
          await context.writeResource(
            "codeConformanceReview",
            "codeConformanceReview-main",
            {
              planVersion: current.planVersion,
              steps: updatedSteps,
              reviewedAt: new Date().toISOString(),
            },
          ),
        );

        const justified = args.justifications.length;
        const remaining = updatedSteps.filter(
          (s) => s.status !== "implemented" && !s.justification,
        ).length;

        context.logger.info(
          "Justified {justified} deviation(s), {remaining} unjustified deviation(s) remain",
          { justified, remaining },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "deviations_justified",
          targetStatus: "in_progress",
          summary:
            `${justified} deviation(s) justified, ${remaining} unjustified remain`,
          emoji: "\u{2705}",
          payload: {
            justified,
            remaining,
            justifications: args.justifications,
          },
          isVerbose: false,
        });

        return { dataHandles: handles };
      },
    },

    approve: {
      rollbackOnFailure: true,
      description: "Approve the current plan",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const handles = [];

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "approved",
            issueNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        const plan = await context.readResource!("plan-main") as
          | PlanData
          | null;

        context.logger.info("Plan approved", {});

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc && plan) {
          // Transition before the entry post — see the note in `triage`.
          recordUpstreamChange(
            context.logger,
            "status transition to in_progress",
            await sc.transitionStatus("in_progress"),
          );
          await advanceLinked(
            sc,
            await readLinkedIssues(context.readResource),
            "in_progress",
            context.logger,
          );
          await recordLifecycle(sc, {
            step: "plan_approved",
            targetStatus: "in_progress",
            summary:
              `Plan approved (v${plan.version}) \u2014 implementation starting`,
            emoji: "\u{2705}",
            payload: {
              version: plan.version,
              summary: plan.summary,
              stepsCount: plan.steps.length,
            },
            isVerbose: true,
          });
        }

        return { dataHandles: handles };
      },
    },

    implement: {
      rollbackOnFailure: true,
      description: "Signal that implementation has started",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "implementing",
          issueNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info("Implementation started", {});

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "implementation_started",
          targetStatus: "in_progress",
          summary: "Implementation started",
          emoji: "\u{1F680}",
          payload: {},
          isVerbose: false,
        });
        await mirrorMilestone(
          sc,
          await readLinkedIssues(context.readResource),
          issueNumber,
          { step: "implementation_started" },
          context.logger,
        );

        return { dataHandles: [stateHandle] };
      },
    },

    fast_forward: {
      rollbackOnFailure: true,
      description:
        "Fast-forward lifecycle for ad-hoc work. Atomically writes " +
        "classification, plan, adversarial review, and code conformance " +
        "review, then transitions to implementing. Used when a tracking " +
        "issue was created retroactively for work already done.",
      arguments: z.object({
        summary: z.string().describe(
          "Brief description of the work done",
        ),
        steps: z.array(PlanStepSchema).describe(
          "Retroactive plan steps describing the work already completed",
        ),
        testingStrategy: z.string().describe(
          "How the changes were or will be tested",
        ),
      }),
      execute: async (
        args: {
          summary: string;
          steps: Array<{
            order: number;
            description: string;
            files: string[];
            risks?: string;
          }>;
          testingStrategy: string;
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();
        const handles = [];

        handles.push(
          await context.writeResource(
            "classification",
            "classification-main",
            {
              type: "platform",
              confidence: "high",
              reasoning: "Ad-hoc work — retroactive tracking issue created",
              classifiedAt: now,
            },
          ),
        );

        handles.push(
          await context.writeResource("plan", "plan-main", {
            version: 1,
            summary: args.summary,
            dddAnalysis: "Retroactive — work already completed",
            steps: args.steps,
            testingStrategy: args.testingStrategy,
            potentialChallenges: [],
            feedbackIncorporated: [],
            generatedAt: now,
          }),
        );

        handles.push(
          await context.writeResource(
            "adversarialReview",
            "adversarialReview-main",
            {
              planVersion: 1,
              findings: [],
              reviewedAt: now,
            },
          ),
        );

        handles.push(
          await context.writeResource(
            "codeConformanceReview",
            "codeConformanceReview-main",
            {
              planVersion: 1,
              steps: args.steps.map((s) => ({
                order: s.order,
                status: "implemented",
                description: s.description,
              })),
              reviewedAt: now,
            },
          ),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "implementing",
            issueNumber,
            updatedAt: now,
          }),
        );

        context.logger.info(
          "Fast-forwarded lifecycle to implementing: {summary}",
          { summary: args.summary },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc) {
          const linked = await readLinkedIssues(context.readResource);
          await assertLinkedParity(
            sc,
            { number: issueNumber, type: "platform" },
            linked,
          );
          recordUpstreamChange(
            context.logger,
            "issue type update",
            await sc.updateType("platform"),
          );
          // Walk through triaged first — a freshly filed issue is in status
          // open, and swamp-club rejects a direct jump to in_progress.
          recordUpstreamChange(
            context.logger,
            "status transition to triaged",
            await sc.transitionStatus("triaged"),
          );
          recordUpstreamChange(
            context.logger,
            "status transition to in_progress",
            await sc.transitionStatus("in_progress"),
          );
          await advanceLinked(sc, linked, "in_progress", context.logger);
          await recordLifecycle(sc, {
            step: "fast_forwarded",
            targetStatus: "in_progress",
            summary:
              `Lifecycle fast-forwarded for ad-hoc work — ${args.summary}`,
            emoji: "\u{23E9}",
            payload: {
              summary: args.summary,
              stepsCount: args.steps.length,
              testingStrategy: args.testingStrategy,
            },
            isVerbose: true,
          });
        }

        return { dataHandles: handles };
      },
    },

    verify: {
      rollbackOnFailure: true,
      description:
        "Start verification — transitions to verifying phase. The agent " +
        "runs the verification workflows on the host.",
      arguments: z.object({
        commit: z.string().describe("Commit SHA being verified"),
        branch: z.string().describe("Branch being verified"),
      }),
      execute: async (
        args: { commit: string; branch: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "verifying",
          issueNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Verification started for commit {commit} on {branch}",
          { commit: args.commit, branch: args.branch },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "verification_started",
          targetStatus: "in_progress",
          summary: `Verification started for ${args.commit} on ${args.branch}`,
          emoji: "\u{1F50D}",
          payload: { commit: args.commit, branch: args.branch },
          isVerbose: false,
        });

        return { dataHandles: [stateHandle] };
      },
    },

    verification_passed: {
      rollbackOnFailure: true,
      description:
        "Record that verification passed. Carries the full verification " +
        "checklist — every step, status, and gate result. This data gates " +
        "the transition to link_pr.",
      arguments: z.object({
        workflowRunId: z.string(),
        commit: z.string(),
        branch: z.string(),
        steps: z.array(z.object({
          job: z.string(),
          step: z.string(),
          model: z.string(),
          method: z.string().default("execute"),
          status: z.enum(["succeeded", "failed", "skipped"]),
        })),
      }),
      execute: async (
        args: {
          workflowRunId: string;
          commit: string;
          branch: string;
          steps: Array<{
            job: string;
            step: string;
            model: string;
            method: string;
            status: "succeeded" | "failed" | "skipped";
          }>;
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();

        const succeeded = args.steps.filter((s) => s.status === "succeeded")
          .length;
        const skipped = args.steps.filter((s) => s.status === "skipped").length;
        const failed = args.steps.filter((s) => s.status === "failed").length;

        const verificationHandle = await context.writeResource(
          "verificationResult",
          "verificationResult-main",
          {
            workflowRunId: args.workflowRunId,
            commit: args.commit,
            branch: args.branch,
            allPassed: failed === 0,
            stepsCompleted: succeeded,
            stepsTotal: args.steps.length,
            stepsSkipped: skipped,
            stepsFailed: failed,
            steps: args.steps,
            verifiedAt: now,
          },
        );

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "verifying",
          issueNumber,
          updatedAt: now,
        });

        context.logger.info(
          "Verification passed: {succeeded}/{total} steps, {skipped} skipped",
          { succeeded, total: args.steps.length, skipped },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "verification_passed",
          targetStatus: "in_progress",
          summary:
            `Verification passed: ${succeeded}/${args.steps.length} steps`,
          emoji: "✅",
          payload: {
            workflowRunId: args.workflowRunId,
            commit: args.commit,
            stepsCompleted: succeeded,
            stepsTotal: args.steps.length,
          },
          isVerbose: false,
        });
        await mirrorMilestone(
          sc,
          await readLinkedIssues(context.readResource),
          issueNumber,
          { step: "verification_passed", commit: args.commit },
          context.logger,
        );

        return { dataHandles: [verificationHandle, stateHandle] };
      },
    },

    verification_failed: {
      rollbackOnFailure: true,
      description:
        "Record that verification failed. Transitions back to implementing " +
        "so the agent can fix issues and re-verify.",
      arguments: z.object({
        workflowRunId: z.string(),
        commit: z.string(),
        branch: z.string(),
        failureReason: z.string().describe(
          "Summary of what failed in the verification workflow",
        ),
      }),
      execute: async (
        args: {
          workflowRunId: string;
          commit: string;
          branch: string;
          failureReason: string;
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "implementing",
          issueNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info("Verification failed: {reason}", {
          reason: args.failureReason,
        });

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "verification_failed",
          targetStatus: "in_progress",
          summary: `Verification failed: ${args.failureReason}`,
          emoji: "❌",
          payload: {
            workflowRunId: args.workflowRunId,
            commit: args.commit,
            failureReason: args.failureReason,
          },
          isVerbose: false,
        });

        return { dataHandles: [stateHandle] };
      },
    },

    post_attestation: {
      description:
        "Post the verification attestation to swamp-club. Must be called " +
        "after verification passes and the user confirms the checklist, " +
        "before opening a PR. The PR must not open without a stored " +
        "attestation — this is a hard gate.",
      arguments: z.object({
        attestation: z.string().min(1).describe(
          "The verification attestation JSON as a string, as " +
            "`deno run build-attestation` writes it. Validated against " +
            "AttestationSchema before it is posted — build it with the " +
            "generator rather than by hand.",
        ),
      }),
      execute: async (
        args: { attestation: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        // Validated before the client is built, so a malformed document
        // fails without dialing out. The shape used to be enforced nowhere:
        // this method posted whatever parsed, and `.github/workflows/ci.yml`
        // read the fields it needed with `jq` once the PR was already public.
        // An attestation missing `subject` posted cleanly and logged
        // `commit=undefined`. Checking here moves that contract to the moment
        // before the document leaves the machine, where the failure is still
        // cheap and the operator is still standing in front of it.
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.attestation);
        } catch {
          throw new Error("attestation input is not valid JSON");
        }

        const validated = AttestationSchema.safeParse(parsed);
        if (!validated.success) {
          const issues = validated.error.issues
            .map((issue) =>
              `  ${issue.path.join(".") || "(root)"}: ${issue.message}`
            )
            .join("\n");
          throw new Error(
            "attestation does not match AttestationSchema:\n" + issues +
              "\n\nBuild it with `deno run build-attestation` rather than by " +
              "hand — the generator projects every field from the " +
              "verification run records.",
          );
        }
        const attestation = validated.data;

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (!sc) {
          throw new Error(
            "swamp-club is not reachable or credentials are missing. " +
              "Set SWAMP_API_KEY or run `swamp auth login`.",
          );
        }

        const result = await sc.postAttestation(attestation);

        context.logger.info(
          "Attestation posted to swamp-club: id={id} postedBy={postedBy}",
          { id: result.id, postedBy: result.postedBy },
        );

        // The one deliberate downgrade in this model. Unlike every other
        // method, the attestation POST above has already written a durable
        // upstream record that rollback cannot reach, and this entry cannot
        // run first because its payload carries the id that POST returned.
        // Failing here would send the operator into a re-run that files a
        // second attestation for the same commit — worse than a missing
        // entry, since the attestation row is itself the audit record and
        // `postAttestation` already raises when it fails. The id is named in
        // the warning so the entry can be reconstructed by hand.
        try {
          await recordLifecycle(sc, {
            step: "attestation_posted",
            targetStatus: "in_progress",
            summary: "Verification attestation posted to swamp-club",
            emoji: "\u{1F4DC}",
            payload: {
              attestationId: result.id,
              commit: attestation.subject.commit,
              gatePassed: attestation.gate.allPassed,
            },
            isVerbose: false,
          });
        } catch (err) {
          context.logger.warning(
            "Attestation {id} was posted, but its lifecycle entry was not " +
              "recorded: {error}. The attestation itself is the durable " +
              "record; re-running this method would file a duplicate.",
            { id: result.id, error: String(err) },
          );
        }

        await mirrorMilestone(
          sc,
          await readLinkedIssues(context.readResource),
          context.globalArgs.issueNumber,
          {
            step: "attestation_posted",
            attestationId: result.id,
            commit: attestation.subject.commit,
          },
          context.logger,
        );

        return { dataHandles: [] };
      },
    },

    link_pr: {
      rollbackOnFailure: true,
      description:
        "Link a pull request to the implementation. Idempotent — calling " +
        "again overwrites the recorded URL with the latest link. " +
        "Transitions the phase to pr_open from implementing or pr_failed.",
      arguments: z.object({
        url: z.string().min(1).describe(
          "Canonical pull request URL. Opaque to the model — pass whatever " +
            "URL your git host produced.",
        ),
      }),
      execute: async (
        args: { url: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();

        const existing = await context.readResource("pullRequest-main") as
          | PullRequestData
          | null;
        const attempt = existing ? (existing.attempt ?? 0) + 1 : 1;

        const prHandle = await context.writeResource(
          "pullRequest",
          "pullRequest-main",
          {
            url: args.url,
            attempt,
            linkedAt: now,
          },
        );

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "pr_open",
          issueNumber,
          updatedAt: now,
        });

        context.logger.info("PR linked (attempt {attempt}): {url}", {
          attempt,
          url: args.url,
        });

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        const linked = await readLinkedIssues(context.readResource);
        if (sc) {
          // Recorded on the issue itself so it shows while work is in
          // progress and survives the shipped transition into the reporter's
          // notification. Idempotent, so it runs before the entry post.
          recordUpstreamChange(
            context.logger,
            "PR link on the issue",
            await sc.linkPr(args.url),
          );
        }
        await linkPrOnLinked(sc, linked, args.url, context.logger);
        await recordLifecycle(sc, {
          step: "pr_linked",
          targetStatus: "in_progress",
          summary: `PR linked (attempt ${attempt}): ${args.url}`,
          emoji: "\u{1F517}",
          payload: { url: args.url, attempt },
          isVerbose: false,
        });
        await mirrorMilestone(
          sc,
          linked,
          issueNumber,
          { step: "pr_linked", url: args.url, attempt },
          context.logger,
        );

        return { dataHandles: [prHandle, stateHandle] };
      },
    },

    pr_merged: {
      rollbackOnFailure: true,
      description:
        "Record that the linked PR has been merged. Transitions to releasing.",
      arguments: z.object({
        mergedAt: z.string().optional().describe(
          "ISO-8601 timestamp of when the PR was merged. Defaults to now.",
        ),
      }),
      execute: async (
        args: { mergedAt?: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();
        const handles = [];

        const prContent = await context.readResource("pullRequest-main") as
          | PullRequestData
          | null;
        if (!prContent) {
          throw new Error("No pull request linked. Call link_pr first.");
        }

        const attempt = prContent.attempt ?? 1;

        handles.push(
          await context.writeResource("pullRequest", "pullRequest-main", {
            url: prContent.url,
            attempt,
            linkedAt: prContent.linkedAt,
            mergedAt: args.mergedAt ?? now,
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "releasing",
            issueNumber,
            updatedAt: now,
          }),
        );

        context.logger.info(
          "PR merged (attempt {attempt}) \u2014 awaiting release build",
          { attempt },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "pr_merged",
          targetStatus: "in_progress",
          summary:
            `PR merged (attempt ${attempt}): ${prContent.url} \u2014 awaiting release`,
          emoji: "\u{1F389}",
          payload: {
            url: prContent.url,
            attempt,
            mergedAt: args.mergedAt ?? now,
          },
          isVerbose: false,
        });
        await mirrorMilestone(
          sc,
          await readLinkedIssues(context.readResource),
          issueNumber,
          { step: "pr_merged", url: prContent.url, attempt },
          context.logger,
        );

        return { dataHandles: handles };
      },
    },

    pr_failed: {
      rollbackOnFailure: true,
      description:
        "Record that the linked PR has failed (CI failure, review rejection, etc.). " +
        "Transitions to pr_failed so the agent knows to fix and re-link.",
      arguments: z.object({
        reason: z.string().min(1).describe(
          "Why the PR failed: CI failure details, review rejection reason, etc.",
        ),
      }),
      execute: async (
        args: { reason: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();
        const handles = [];

        const prContent = await context.readResource("pullRequest-main") as
          | PullRequestData
          | null;
        if (!prContent) {
          throw new Error("No pull request linked. Call link_pr first.");
        }

        const attempt = prContent.attempt ?? 1;

        handles.push(
          await context.writeResource("pullRequest", "pullRequest-main", {
            url: prContent.url,
            attempt,
            linkedAt: prContent.linkedAt,
            failedAt: now,
            failureReason: args.reason,
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "pr_failed",
            issueNumber,
            updatedAt: now,
          }),
        );

        context.logger.info("PR failed (attempt {attempt}): {reason}", {
          attempt,
          reason: args.reason,
        });

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "pr_failed",
          targetStatus: "in_progress",
          summary: `PR failed (attempt ${attempt}): ${args.reason}`,
          emoji: "\u{274C}",
          payload: { url: prContent.url, attempt, reason: args.reason },
          isVerbose: false,
        });
        await mirrorMilestone(
          sc,
          await readLinkedIssues(context.readResource),
          issueNumber,
          { step: "pr_failed", url: prContent.url, attempt },
          context.logger,
        );

        return { dataHandles: handles };
      },
    },

    ship: {
      rollbackOnFailure: true,
      description:
        "Mark the release as shipped after the release build completes. " +
        "Transitions to done and sets swamp-club status to shipped.",
      arguments: z.object({
        releaseUrl: z.string().optional().describe(
          "URL of the release (e.g., GitHub release page, package registry). Optional.",
        ),
        releaseNotes: z.string().optional().describe(
          "Brief release notes or summary. Optional.",
        ),
      }),
      execute: async (
        args: { releaseUrl?: string; releaseNotes?: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "notify",
          issueNumber,
          updatedAt: now,
        });

        context.logger.info("Shipped — awaiting contributor notification", {});

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc) {
          // Transition before the entry post — see the note in `triage`.
          recordUpstreamChange(
            context.logger,
            "status transition to shipped",
            await sc.transitionStatus("shipped"),
          );
          const linked = await readLinkedIssues(context.readResource);
          await advanceLinked(sc, linked, "shipped", context.logger);
          await recordLifecycle(sc, {
            step: "shipped",
            targetStatus: "shipped",
            summary: args.releaseUrl
              ? `Shipped: ${args.releaseUrl}`
              : "Shipped",
            emoji: "\u{1F680}",
            payload: {
              releaseUrl: args.releaseUrl,
              releaseNotes: args.releaseNotes,
            },
            isVerbose: false,
          });
          await mirrorMilestone(
            sc,
            linked,
            issueNumber,
            { step: "shipped", releaseUrl: args.releaseUrl },
            context.logger,
          );
        }

        return { dataHandles: [stateHandle] };
      },
    },

    complete: {
      rollbackOnFailure: true,
      description: "Mark the issue lifecycle as done",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "notify",
          issueNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Issue lifecycle complete — awaiting contributor notification",
          {},
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc) {
          // Transition before the entry post — see the note in `triage`.
          recordUpstreamChange(
            context.logger,
            "status transition to shipped",
            await sc.transitionStatus("shipped"),
          );
          const linked = await readLinkedIssues(context.readResource);
          await advanceLinked(sc, linked, "shipped", context.logger);
          await recordLifecycle(sc, {
            step: "complete",
            targetStatus: "shipped",
            summary: "Complete",
            emoji: "\u{2705}",
            payload: {},
            isVerbose: false,
          });
          await mirrorMilestone(
            sc,
            linked,
            issueNumber,
            { step: "complete" },
            context.logger,
          );
        }

        return { dataHandles: [stateHandle] };
      },
    },

    notify: {
      description:
        "Thank the issue author with a ripple on the issue, unless they are " +
        "on swamp-club's team roster (eligible assignees). Fails without " +
        "posting when membership cannot be confirmed. Transitions to " +
        "summarizing.",
      arguments: z.object({
        message: z.string().optional().describe(
          "Custom thank-you message. If omitted, a default message is generated.",
        ),
        force: z.boolean().optional().describe(
          "Post the thank-you without checking the team roster, e.g. to " +
            "thank a team member deliberately.",
        ),
      }),
      execute: async (
        args: { message?: string; force?: boolean },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;

        const prData = await context.readResource("pullRequest-main") as
          | PullRequestData
          | null;
        const planData = await context.readResource("plan-main") as
          | PlanData
          | null;
        const duplicate = await context.readResource("duplicate-main") as
          | DuplicateData
          | null;
        const linked = await readLinkedIssues(context.readResource);

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );

        // The ripple cannot be taken back, so every lookup that decides it
        // runs first and fails closed. The handle mentioned and the id
        // checked come from the same fetch.
        let author: string | undefined;
        let teamMember = false;
        // Fetched at most once and shared with the linked-author pass below.
        let roster: EligibleAssignee[] | null = null;
        if (sc) {
          const issue = await sc.fetchIssue();
          if (!issue) {
            throw notifyUndecided(
              `Could not fetch issue #${issueNumber} to identify its author`,
            );
          }
          if (issue.author !== "unknown") author = issue.author;
          if (author && !args.force) {
            roster = await sc.fetchEligibleAssignees();
            if (!roster) {
              throw notifyUndecided(
                `Could not confirm whether @${author} is a swamp-club team ` +
                  "member (the eligible-assignees lookup failed)",
              );
            }
            teamMember = isTeamMember(issue, roster);
          }
        }

        if (author && teamMember) {
          context.logger.info(
            "@{author} is a swamp-club team member — no thank-you posted",
            { author },
          );
        } else if (author && sc) {
          const body = args.message ??
            buildNotifyMessage(author, prData, planData, duplicate);
          // The ripple is this method's deliverable, not a courtesy, so a
          // failure raises. It runs before the state write, so the phase is
          // still `notify` and the re-run retries it with no duplicate.
          await recordRipple(sc, body);
          context.logger.info(
            "Posted thank-you ripple for @{author} on issue #{issueNumber}",
            { author, issueNumber },
          );
        } else {
          context.logger.warning(
            "Could not determine issue author — skipping notification",
            {},
          );
        }

        // Linked issues' authors are thanked after the primary's, and only
        // best-effort: this method does not roll back, so raising after one
        // ripple posted would make the re-run thank that author twice. The
        // message leaves out the primary's plan summary, which may come from
        // an issue the linked issue's reader cannot see.
        // `force` is about the primary's author only, so linked authors are
        // always checked against the roster.
        if (sc && linked.length > 0) {
          const linkedRoster = roster ?? await sc.fetchEligibleAssignees();
          if (!linkedRoster) {
            context.logger.warning(
              "Could not fetch the team roster, so no linked issue's author " +
                "was thanked",
              {},
            );
          } else {
            for (const issue of linked) {
              if (!issue.author || issue.author === "unknown") continue;
              if (
                isTeamMember(
                  { author: issue.author, authorId: issue.authorId },
                  linkedRoster,
                )
              ) continue;
              const linkedSc = sc.forIssue(issue.issueNumber);
              const posted = await recordRippleBestEffort(
                linkedSc,
                context.logger,
                buildNotifyMessage(issue.author, prData, null),
              );
              if (!posted) continue;
              await recordLifecycleBestEffort(linkedSc, context.logger, {
                step: "contributor_notified",
                targetStatus: "shipped",
                summary: `Thanked @${issue.author}`,
                emoji: "\u{1F64F}",
                payload: {
                  author: issue.author,
                  primaryIssueNumber: issueNumber,
                },
                isVerbose: false,
              });
            }
          }
        }

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "summarizing",
          issueNumber,
          updatedAt: new Date().toISOString(),
        });

        if (sc) {
          if (author && teamMember) {
            await recordLifecycle(sc, {
              step: "notification_skipped",
              targetStatus: "shipped",
              summary: `Skipped thanks: @${author} is a swamp-club team member`,
              emoji: "\u{23ED}\u{FE0F}",
              payload: { author, reason: "team_member" },
              isVerbose: false,
            });
          } else {
            await recordLifecycle(sc, {
              step: "contributor_notified",
              targetStatus: "shipped",
              summary: author
                ? `Thanked @${author}`
                : "Notification skipped (unknown author)",
              emoji: "\u{1F64F}",
              payload: { author: author ?? "unknown" },
              isVerbose: false,
            });
          }
        }

        return { dataHandles: [stateHandle] };
      },
    },

    skip_notify: {
      rollbackOnFailure: true,
      description:
        "Skip contributor notification and transition to summarizing. " +
        "Use when no notification is wanted; notify already skips team members.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "summarizing",
          issueNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info("Contributor notification skipped", {});

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc) {
          await recordLifecycle(sc, {
            step: "notification_skipped",
            targetStatus: "shipped",
            summary: "Contributor notification skipped",
            emoji: "\u{23ED}\u{FE0F}",
            payload: {},
            isVerbose: false,
          });
        }

        return { dataHandles: [stateHandle] };
      },
    },

    summarize: {
      rollbackOnFailure: true,
      description:
        "Record a session summary restating the original problem and delivered outcome. " +
        "Transitions to done. Must be called after notify/skip_notify.",
      arguments: z.object({
        originalProblem: z.string().describe(
          "Plain-language restatement of the bug or feature request from the issue.",
        ),
        deliveredOutcome: z.string().describe(
          "Plain-language description of what was actually built or fixed.",
        ),
        outcomeMet: z.boolean().describe(
          "Whether the delivered outcome addresses the original problem.",
        ),
        linkedOutcomes: z.array(LinkedOutcomeSchema).optional().describe(
          "One outcome per linked issue — required when the lifecycle " +
            "carries linked issues, and must name each exactly once.",
        ),
      }),
      execute: async (
        args: {
          originalProblem: string;
          deliveredOutcome: string;
          outcomeMet: boolean;
          linkedOutcomes?: Array<{
            issueNumber: number;
            deliveredOutcome: string;
            outcomeMet: boolean;
          }>;
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const handles = [];

        // Every issue this lifecycle carried gets its own outcome, so none
        // can be closed out on the strength of the primary's.
        const linked = await readLinkedIssues(context.readResource);
        const outcomes = args.linkedOutcomes ?? [];
        const expected = new Set(linked.map((l) => l.issueNumber));
        const named = outcomes.map((o) => o.issueNumber);
        const missing = [...expected].filter((n) => !named.includes(n));
        const extra = named.filter((n) => !expected.has(n));
        const repeated = named.filter((n, i) => named.indexOf(n) !== i);
        if (missing.length || extra.length || repeated.length) {
          const problems = [
            missing.length
              ? `no outcome for linked issue(s) ${
                missing.map((n) => `#${n}`).join(", ")
              }`
              : "",
            extra.length
              ? `outcome for issue(s) ${
                extra.map((n) => `#${n}`).join(", ")
              } that this lifecycle does not carry`
              : "",
            repeated.length
              ? `more than one outcome for ${
                [...new Set(repeated)].map((n) => `#${n}`).join(", ")
              }`
              : "",
          ].filter(Boolean);
          throw new Error(
            `linkedOutcomes must name each linked issue exactly once: ` +
              `${problems.join("; ")}.`,
          );
        }

        handles.push(
          await context.writeResource("summary", "summary-main", {
            originalProblem: args.originalProblem,
            deliveredOutcome: args.deliveredOutcome,
            outcomeMet: args.outcomeMet,
            ...(outcomes.length ? { linkedOutcomes: outcomes } : {}),
            summarizedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "done",
            issueNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info(
          "Session summary recorded — outcome {met}: {outcome}",
          {
            met: args.outcomeMet ? "met" : "not met",
            outcome: args.deliveredOutcome,
          },
        );

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await recordLifecycle(sc, {
          step: "session_summarized",
          targetStatus: "shipped",
          summary: args.outcomeMet
            ? `Outcome met: ${args.deliveredOutcome}`
            : `Outcome NOT met: ${args.deliveredOutcome}`,
          emoji: "\u{1F4DD}",
          payload: {
            originalProblem: args.originalProblem,
            deliveredOutcome: args.deliveredOutcome,
            outcomeMet: args.outcomeMet,
          },
          isVerbose: false,
        });
        // Best-effort for the same reason as mirrors: the posts cannot be
        // taken back, and the primary's entry above is the audit record.
        if (sc) {
          for (const outcome of outcomes) {
            await recordLifecycleBestEffort(
              sc.forIssue(outcome.issueNumber),
              context.logger,
              {
                step: "session_summarized",
                targetStatus: "shipped",
                summary: outcome.outcomeMet
                  ? `Outcome met: ${outcome.deliveredOutcome}`
                  : `Outcome NOT met: ${outcome.deliveredOutcome}`,
                emoji: "\u{1F4DD}",
                payload: {
                  primaryIssueNumber: issueNumber,
                  deliveredOutcome: outcome.deliveredOutcome,
                  outcomeMet: outcome.outcomeMet,
                },
                isVerbose: false,
              },
            );
          }
        }

        return { dataHandles: handles };
      },
    },

    link_issue: {
      rollbackOnFailure: true,
      description:
        "Carry another swamp-club issue with this lifecycle, because the " +
        "same work fixes it. Creates the relationship in swamp-club " +
        "(related_to from this issue, or duplicate_of from the linked " +
        "issue), catches the linked issue up to this issue's status and PR, " +
        "and from then on moves it with this issue. The phase is unchanged. " +
        "Re-linking the same issue updates it in place.",
      arguments: z.object({
        issueNumber: z.number().int().positive().describe(
          "The swamp-club issue to carry.",
        ),
        relationship: LinkRelationship.default("related_to").describe(
          "related_to (shown as Sibling of) when the work also fixes it; " +
            "duplicate_of when it reports the same problem as this issue.",
        ),
        reason: z.string().optional().describe(
          "Why the issue is being carried with this one.",
        ),
      }),
      execute: async (
        args: {
          issueNumber: number;
          relationship: "related_to" | "duplicate_of";
          reason?: string;
        },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const primary = context.globalArgs.issueNumber;
        const target = args.issueNumber;
        const relationship = args.relationship ?? "related_to";
        if (target === primary) {
          throw new Error(`Issue #${primary} cannot be linked to itself.`);
        }

        const sc = await requireSwampClub(context);
        const linkedSc = sc.forIssue(target);
        const primaryIssue = await sc.fetchIssue();
        if (!primaryIssue) {
          throw new Error(`Could not fetch issue #${primary} from swamp-club.`);
        }
        const linkedIssue = await linkedSc.fetchIssue();
        if (!linkedIssue) {
          throw new Error(
            `swamp-club issue #${target} was not found, so it cannot be linked.`,
          );
        }
        if (linkedIssue.status === "shipped") {
          throw new Error(
            `Issue #${target} has already shipped, so there is nothing for ` +
              `this lifecycle to carry.`,
          );
        }
        const parity = securityParityError(
          { number: primary, type: primaryIssue.type },
          { number: target, type: linkedIssue.type },
        );
        if (parity) throw new Error(parity);

        await warnIfCarriedElsewhere(sc, linkedIssue, primary, context.logger);

        const state = await context.readResource?.("state-main") as
          | StateData
          | null;
        const phase = state?.phase ?? "triaging";
        const pr = await context.readResource?.("pullRequest-main") as
          | PullRequestData
          | null;
        const now = new Date().toISOString();

        const entry: LinkedIssueData = {
          issueNumber: target,
          relationship,
          title: linkedIssue.title,
          author: linkedIssue.author === "unknown"
            ? undefined
            : linkedIssue.author,
          authorId: linkedIssue.authorId,
          reason: args.reason,
          linkedAt: now,
        };
        const existing = await readLinkedIssues(context.readResource);
        // Changing how an issue is linked would leave the old relationship
        // in swamp-club, where unlink_issue would no longer find it.
        const previous = existing.find((i) => i.issueNumber === target);
        if (previous && previous.relationship !== relationship) {
          throw new Error(
            `Issue #${target} is already linked as ${previous.relationship}. ` +
              `Unlink it with unlink_issue before linking it as ${relationship}.`,
          );
        }
        const others = existing.filter((i) => i.issueNumber !== target);
        const handle = await context.writeResource(
          "linkedIssues",
          "linkedIssues-main",
          { issues: [...others, entry], updatedAt: now },
        );

        // Every write below is idempotent, so all of them run before the
        // entry posts: a failure rolls back and the re-run converges.
        recordUpstreamChange(
          context.logger,
          `${relationship} relationship between #${primary} and #${target}`,
          relationship === "duplicate_of"
            ? await linkedSc.addRelationship("duplicate_of", primary)
            : await sc.addRelationship("related_to", target),
        );
        const reopened = linkedIssue.status === "closed";
        const status = upstreamStatusForPhase(phase);
        recordUpstreamChange(
          context.logger,
          `status transition of linked issue #${target} to ${status}`,
          await linkedSc.walkStatusTo(status),
        );
        if (pr?.url) {
          recordUpstreamChange(
            context.logger,
            `PR link on linked issue #${target}`,
            await linkedSc.linkPr(pr.url),
          );
        }

        const label = relationship === "duplicate_of" ? "duplicate" : "sibling";
        await recordLifecycle(sc, {
          step: "issue_linked",
          targetStatus: status,
          summary: `Carrying #${target} (${label}) with this issue`,
          emoji: "\u{1F517}",
          payload: {
            linkedIssueNumber: target,
            relationship,
            reason: args.reason,
          },
          isVerbose: false,
        });
        // The linked issue's own note is best-effort, like every other entry
        // on a linked issue: the primary's entry above is the audit record.
        await recordLifecycleBestEffort(linkedSc, context.logger, {
          step: "linked",
          targetStatus: status,
          summary: (relationship === "duplicate_of"
            ? `Marked as a duplicate of #${primary}`
            : `Fixed alongside #${primary}`) +
            ` — the work is tracked there` +
            (reopened ? " (reopened from closed)" : ""),
          emoji: "\u{1F517}",
          payload: { primaryIssueNumber: primary, relationship, reopened },
          isVerbose: false,
        });

        context.logger.info(
          "Linked #{linked} ({relationship}); it now moves with #{primary}",
          { linked: target, relationship, primary },
        );

        return { dataHandles: [handle] };
      },
    },

    unlink_issue: {
      rollbackOnFailure: true,
      description:
        "Stop carrying a linked issue. Removes it from this lifecycle and " +
        "deletes the swamp-club relationship. Its status is left where it " +
        "is — swamp-club has no backward transitions — so close or " +
        "re-triage it by hand if it should not stay in progress.",
      arguments: z.object({
        issueNumber: z.number().int().positive().describe(
          "The linked issue to stop carrying.",
        ),
        reason: z.string().min(1).describe("Why the link is being removed."),
      }),
      execute: async (
        args: { issueNumber: number; reason: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const primary = context.globalArgs.issueNumber;
        const target = args.issueNumber;
        const linked = await readLinkedIssues(context.readResource);
        const entry = linked.find((i) => i.issueNumber === target);
        if (!entry) {
          throw new Error(`Issue #${target} is not linked to #${primary}.`);
        }

        const sc = await requireSwampClub(context);
        const linkedSc = sc.forIssue(target);
        const handle = await context.writeResource(
          "linkedIssues",
          "linkedIssues-main",
          {
            issues: linked.filter((i) => i.issueNumber !== target),
            updatedAt: new Date().toISOString(),
          },
        );

        const linkedIssue = await linkedSc.fetchIssue();
        if (!linkedIssue) {
          throw new Error(`Could not fetch issue #${target} from swamp-club.`);
        }
        // Seen from the linked issue, link_issue's related_to comes in from
        // the primary and its duplicate_of goes out to it. Matching the
        // direction keeps a hand-made link the other way from being removed.
        const direction = entry.relationship === "duplicate_of"
          ? "outgoing"
          : "incoming";
        const relationship = linkedIssue.relationships.find((r) =>
          r.type === entry.relationship && r.otherIssueNumber === primary &&
          r.direction === direction
        );
        if (!relationship) {
          context.logger.warning(
            "No {type} relationship between #{primary} and #{linked} was " +
              "found in swamp-club, so none was removed",
            { type: entry.relationship, primary, linked: target },
          );
        }
        // swamp-club deletes a relationship through either issue it joins, so
        // the linked issue's endpoint serves both link directions.
        if (relationship) {
          recordUpstreamChange(
            context.logger,
            `removal of the relationship between #${primary} and #${target}`,
            await linkedSc.removeRelationship(relationship.id),
          );
        }

        const state = await context.readResource?.("state-main") as
          | StateData
          | null;
        await recordLifecycle(sc, {
          step: "issue_unlinked",
          targetStatus: upstreamStatusForPhase(state?.phase ?? "triaging"),
          summary: `No longer carrying #${target}: ${args.reason}`,
          emoji: "\u{2702}\u{FE0F}",
          payload: { linkedIssueNumber: target, reason: args.reason },
          isVerbose: false,
        });
        await recordLifecycleBestEffort(linkedSc, context.logger, {
          step: "unlinked",
          targetStatus: linkedIssue.status,
          summary: `No longer carried by #${primary}. Its status stays ` +
            `${linkedIssue.status} — close or re-triage this issue if ` +
            `that is wrong.`,
          emoji: "\u{2702}\u{FE0F}",
          payload: { primaryIssueNumber: primary },
          isVerbose: false,
        });

        context.logger.info("Unlinked #{linked}; its status is {status}", {
          linked: target,
          status: linkedIssue.status,
        });

        return { dataHandles: [handle] };
      },
    },

    mark_duplicate: {
      rollbackOnFailure: true,
      description:
        "Ship this issue as a duplicate of one that has already shipped, " +
        "instead of closing it. Links it duplicate_of the canonical issue, " +
        "records the canonical issue's PR on it, and walks it to shipped " +
        "(reopening it first if it was closed), so its reporter gets the " +
        "shipped notification. Transitions to notify. Refused while the " +
        "canonical issue is still in flight — link it from that issue's " +
        "lifecycle with link_issue instead.",
      arguments: z.object({
        of: z.number().int().positive().describe(
          "The canonical issue this one duplicates. It must have shipped.",
        ),
        reason: z.string().min(1).describe(
          "Why this issue is the same problem as the canonical one.",
        ),
        prUrl: z.url({ protocol: /^https?$/ }).optional().describe(
          "The PR that fixed the canonical issue. Used only when swamp-club " +
            "has none recorded for it, on the issue or in its lifecycle " +
            "entries.",
        ),
      }),
      execute: async (
        args: { of: number; reason: string; prUrl?: string },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const canonicalNumber = args.of;
        if (canonicalNumber === issueNumber) {
          throw new Error(
            `Issue #${issueNumber} cannot be a duplicate of itself.`,
          );
        }

        // Shipping this issue as a duplicate would leave any issue it carries
        // stranded short of shipped, and notify would then thank those
        // reporters for a fix that never reached them.
        const linked = await readLinkedIssues(context.readResource);
        if (linked.length > 0) {
          throw new Error(
            `Issue #${issueNumber} carries linked issue(s) ` +
              `${linked.map((l) => `#${l.issueNumber}`).join(", ")}. ` +
              `Unlink them with unlink_issue first; each can then be marked ` +
              `a duplicate of #${canonicalNumber} on its own lifecycle.`,
          );
        }

        const sc = await requireSwampClub(context);
        const canonical = await sc.forIssue(canonicalNumber).fetchIssue();
        if (!canonical) {
          throw new Error(
            `swamp-club issue #${canonicalNumber} was not found.`,
          );
        }
        if (canonical.status === "closed") {
          throw new Error(
            `Issue #${canonicalNumber} was closed without shipping, so ` +
              `there is no fix to ship #${issueNumber} with.`,
          );
        }
        if (canonical.status !== "shipped") {
          throw new Error(
            `Issue #${canonicalNumber} has not shipped yet (it is ` +
              `${canonical.status}). Carry this issue with it instead, from ` +
              `its lifecycle: swamp model @swamp/issue-lifecycle method run ` +
              `link_issue issue-${canonicalNumber} --input ` +
              `issueNumber=${issueNumber} --input relationship=duplicate_of`,
          );
        }
        // No security-parity check, unlike link_issue: the canonical issue
        // has shipped, so its number and PR are already public, and nothing
        // else of it reaches this issue.
        const duplicate = await sc.fetchIssue();
        if (!duplicate) {
          throw new Error(
            `Could not fetch issue #${issueNumber} from swamp-club.`,
          );
        }

        // A URL found on the canonical issue goes into this issue's public
        // thank-you, so it is held to the same http(s) rule as the prUrl
        // argument; link_pr accepts any non-empty string.
        let foundPrUrl: string | undefined;
        for (
          const candidate of [canonical.githubPrUrl, canonical.lifecyclePrUrl]
        ) {
          if (!candidate) continue;
          if (isHttpUrl(candidate)) {
            foundPrUrl = candidate;
            break;
          }
          context.logger.warning(
            "Ignoring the PR URL recorded for #{canonical} because it is not " +
              "an http(s) URL: {url}",
            { canonical: canonicalNumber, url: candidate },
          );
        }
        if (foundPrUrl && args.prUrl && args.prUrl !== foundPrUrl) {
          context.logger.warning(
            "swamp-club already records {found} for #{canonical}, so the " +
              "prUrl argument was not used",
            { found: foundPrUrl, canonical: canonicalNumber },
          );
        }
        const prUrl = foundPrUrl ?? args.prUrl;
        if (!prUrl) {
          context.logger.warning(
            "No PR was found for #{canonical}, so #{issue} ships without " +
              "one. Pass prUrl to record it.",
            { canonical: canonicalNumber, issue: issueNumber },
          );
        }

        const now = new Date().toISOString();
        const handles = [
          await context.writeResource("duplicate", "duplicate-main", {
            canonicalIssueNumber: canonicalNumber,
            canonicalTitle: canonical.title,
            ...(prUrl ? { canonicalPrUrl: prUrl } : {}),
            reason: args.reason,
            markedAt: now,
          }),
          await context.writeResource("state", "state-main", {
            phase: "notify",
            issueNumber,
            updatedAt: now,
          }),
        ];

        // Idempotent writes first, the entry last. The PR goes on before the
        // walk so it is already on the issue when swamp-club sends the
        // shipped notification, which is where the reporter sees it.
        recordUpstreamChange(
          context.logger,
          `duplicate_of relationship to #${canonicalNumber}`,
          await sc.addRelationship("duplicate_of", canonicalNumber),
        );
        if (prUrl) {
          recordUpstreamChange(
            context.logger,
            "PR link on the issue",
            await sc.linkPr(prUrl),
          );
        }
        const reopened = duplicate.status === "closed";
        recordUpstreamChange(
          context.logger,
          "status transition to shipped",
          await sc.walkStatusTo("shipped"),
        );
        // Names the canonical issue by number only: it may be restricted
        // to admins while this one is public.
        await recordLifecycle(sc, {
          step: "duplicate_shipped",
          targetStatus: "shipped",
          summary: `Shipped as a duplicate of #${canonicalNumber}` +
            (prUrl ? `: ${prUrl}` : " — no PR was found for it") +
            (reopened ? " (reopened from closed)" : ""),
          emoji: "\u{1F501}",
          payload: {
            canonicalIssueNumber: canonicalNumber,
            prUrl,
            reason: args.reason,
            reopened,
          },
          isVerbose: false,
        });

        context.logger.info(
          "Shipped #{issue} as a duplicate of #{canonical}",
          { issue: issueNumber, canonical: canonicalNumber },
        );

        return { dataHandles: handles };
      },
    },
  },
};
