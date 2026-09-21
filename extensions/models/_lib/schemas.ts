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

// ---------------------------------------------------------------------------
// Global Arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  issueNumber: z.number().describe(
    "Swamp Club lab issue number (the issue must already exist in swamp-club)",
  ),
  swampClubUrl: z.string().optional().describe(
    "Swamp Club API base URL (defaults to https://swamp-club.com)",
  ),
  swampClubApiKey: z.string().optional().describe(
    "Swamp Club API key (defaults to SWAMP_API_KEY env var)",
  ),
});

// ---------------------------------------------------------------------------
// Phases (state machine)
// ---------------------------------------------------------------------------

export const Phase = z.enum([
  "created",
  "triaging",
  "classified",
  "plan_generated",
  "approved",
  "implementing",
  "verifying",
  "pr_open",
  "pr_failed",
  "releasing",
  "notify",
  "summarizing",
  "done",
]);

export type Phase = z.infer<typeof Phase>;

/** Minimum time (ms) between link_pr and pr_merged/pr_failed to allow CI to run. */
export const PR_COOLDOWN_MS = 3 * 60 * 1000;

/** Valid transitions: method name → allowed source phases */
export const TRANSITIONS: Record<string, Phase[]> = {
  start: [
    "created",
    "triaging",
    "classified",
    "plan_generated",
    "approved",
    "implementing",
    "pr_open",
    "pr_failed",
    "releasing",
    "notify",
  ],
  triage: ["triaging"],
  fast_forward: ["triaging"],
  plan: ["classified"],
  iterate: ["plan_generated"],
  approve: ["plan_generated"],
  implement: ["approved", "pr_failed"],
  adversarial_review: ["plan_generated"],
  resolve_findings: ["plan_generated"],
  code_conformance_review: ["implementing", "pr_failed"],
  justify_deviations: ["implementing", "pr_failed"],
  // Re-verifying is idempotent and must stay legal from every phase a change
  // can be sitting in when its commit moves. CI checks that the attestation's
  // commit equals the PR head, so every push to an open PR needs a fresh
  // verification — and `verify` is what records the commit the gates compare
  // against. Accepting only `implementing` meant refreshing that record
  // required marking a healthy PR failed first.
  verify: ["implementing", "verifying", "pr_open", "pr_failed"],
  verification_passed: ["verifying"],
  verification_failed: ["verifying"],
  post_attestation: ["verifying"],
  link_pr: ["verifying", "pr_open", "pr_failed"],
  pr_merged: ["pr_open"],
  pr_failed: ["pr_open"],
  ship: ["releasing"],
  complete: ["implementing", "pr_open", "releasing"],
  notify: ["notify"],
  skip_notify: ["notify"],
  summarize: ["summarizing"],
};

// ---------------------------------------------------------------------------
// Issue Classification Types
// ---------------------------------------------------------------------------

/** Issue types supported by swamp-club. */
export const IssueType = z.enum(["bug", "feature", "platform", "security"]);
export type IssueType = z.infer<typeof IssueType>;

// ---------------------------------------------------------------------------
// Resource Schemas
// ---------------------------------------------------------------------------

export const StateSchema = z.object({
  phase: Phase,
  issueNumber: z.number(),
  updatedAt: z.string(),
});

export type StateData = z.infer<typeof StateSchema>;

export const ContextSchema = z.object({
  title: z.string(),
  body: z.string(),
  type: IssueType,
  status: z.string(),
  author: z.string().optional().describe(
    "Username of the issue author (opener). Optional for backwards compatibility with older context data.",
  ),
  comments: z.array(
    z.object({
      author: z.string(),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
  fetchedAt: z.string(),
});

export const ClassificationSchema = z.object({
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
    "The strongest argument that this is NOT a regression (e.g. never worked correctly, " +
      "docs were stale, different behavior was expected). Required when isRegression is true.",
  ),
  regressionVerdict: z.enum(["confirmed", "downgraded"]).optional().describe(
    "Final verdict after weighing evidence and counter-evidence. 'confirmed' means " +
      "it is a true regression; 'downgraded' means it is a plain bug. " +
      "Required when isRegression is true.",
  ),
  regressionVerdictReasoning: z.string().optional().describe(
    "Why the verdict stands despite the counter-evidence. Required when isRegression is true.",
  ),
  clarifyingQuestions: z.array(z.string()).optional(),
  classifiedAt: z.string(),
});

export const PlanStepSchema = z.object({
  order: z.number(),
  description: z.string(),
  files: z.array(z.string()),
  risks: z.string().optional(),
});

export const PlanSchema = z.object({
  version: z.number(),
  summary: z.string(),
  dddAnalysis: z.string(),
  steps: z.array(PlanStepSchema),
  testingStrategy: z.string(),
  potentialChallenges: z.array(z.string()),
  feedbackIncorporated: z.array(z.string()),
  generatedAt: z.string(),
});

export type PlanData = z.infer<typeof PlanSchema>;

export const FeedbackSchema = z.object({
  round: z.number(),
  feedback: z.string(),
  planVersionReviewed: z.number(),
  submittedAt: z.string(),
});

export const AdversarialFindingSchema = z.object({
  id: z.string().describe("Unique finding identifier, e.g. ADV-1"),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string().describe(
    "Finding category (e.g. architecture, scope, risk, testing, complexity, correctness, documentation)",
  ),
  description: z.string(),
  resolved: z.boolean().default(false),
  resolutionNote: z.string().optional(),
});

export const AdversarialReviewSchema = z.object({
  planVersion: z.number().describe(
    "The plan version this review applies to",
  ),
  findings: z.array(AdversarialFindingSchema),
  reviewedAt: z.string(),
});

export type AdversarialReviewData = z.infer<typeof AdversarialReviewSchema>;

// ---------------------------------------------------------------------------
// Code Conformance Review Schemas
// ---------------------------------------------------------------------------

export const StepVerificationSchema = z.object({
  order: z.number().describe(
    "Plan step order number, or a new number for unplanned changes",
  ),
  status: z.enum([
    "implemented",
    "deviated",
    "partially_implemented",
    "missing",
    "added",
  ]).describe(
    "How the code relates to the plan step: implemented (matches plan), " +
      "deviated (done differently), partially_implemented (incomplete), " +
      "missing (not done), added (unplanned change not in the plan)",
  ),
  description: z.string().describe(
    "What was found in the code for this step",
  ),
  justification: z.string().optional().describe(
    "Why the code differs from the plan. Required when status is not 'implemented'.",
  ),
});

export const CodeConformanceReviewSchema = z.object({
  planVersion: z.number().describe(
    "The approved plan version this review compares against",
  ),
  steps: z.array(StepVerificationSchema).describe(
    "Per-step verification of plan conformance, plus entries for unplanned changes",
  ),
  reviewedAt: z.string(),
});

export type CodeConformanceReviewData = z.infer<
  typeof CodeConformanceReviewSchema
>;

// ---------------------------------------------------------------------------
// Verification Result Schema
// ---------------------------------------------------------------------------

export const VerificationStepResultSchema = z.object({
  job: z.string(),
  step: z.string(),
  model: z.string(),
  method: z.string(),
  status: z.enum(["succeeded", "failed", "skipped"]),
});

export const VerificationResultSchema = z.object({
  workflowRunId: z.string(),
  commit: z.string(),
  branch: z.string(),
  allPassed: z.boolean(),
  stepsCompleted: z.number(),
  stepsTotal: z.number(),
  stepsSkipped: z.number(),
  stepsFailed: z.number(),
  steps: z.array(VerificationStepResultSchema),
  verifiedAt: z.string(),
});

export type VerificationResultData = z.infer<typeof VerificationResultSchema>;

// ---------------------------------------------------------------------------
// Verification Target Schema
// ---------------------------------------------------------------------------

/**
 * What `verify` was started for.
 *
 * `verify` took a commit and a branch and persisted neither, so
 * `verification_passed` asked for them again with nothing comparing the two —
 * and `verification-clear` read only pass/fail counts, so a result belonging
 * to some other commit satisfied it. This resource is the anchor: every
 * downstream record has to name the commit verification was started for.
 *
 * It does not make the commit trustworthy — it is still whatever the caller
 * passed to `verify`. It makes the records consistent with each other, so a
 * result or an attestation for a different commit cannot pass the gates.
 */
export const VerificationTargetSchema = z.object({
  commit: z.string().describe("Commit SHA verification was started for."),
  branch: z.string().describe("Branch verification was started for."),
  startedAt: z.string().describe("ISO-8601 timestamp of the verify call."),
});

export type VerificationTargetData = z.infer<typeof VerificationTargetSchema>;

// ---------------------------------------------------------------------------
// Attestation Record Schema
// ---------------------------------------------------------------------------

/**
 * Local receipt for an attestation that was accepted by swamp-club.
 *
 * `post_attestation` used to write nothing, so three places could document
 * "a PR must not open without a stored attestation" while nothing downstream
 * had anything to require. This resource is that something: the create-PR step
 * takes it as a data dependency, and the `attestation-posted` check on
 * `link_pr` requires it for anyone who opens a PR by hand.
 */
export const AttestationRecordSchema = z.object({
  attestationId: z.string().describe(
    "The id swamp-club assigned to the stored attestation.",
  ),
  commit: z.string().describe(
    "Commit the attestation is bound to, read from the attestation itself.",
  ),
  branch: z.string().describe("Branch the attestation names."),
  gatePassed: z.boolean().describe(
    "The attestation's own gate.allPassed verdict.",
  ),
  workflowRunId: z.string().optional().describe(
    "Run that produced the attestation. Absent when it was posted by hand.",
  ),
  generatedBy: z.string().optional().describe(
    "How the attestation was produced — 'workflow-step' when a run generated " +
      "it. Absent on attestations assembled outside a run.",
  ),
  postedBy: z.string().describe("Who swamp-club recorded as the poster."),
  postedAt: z.string().describe("ISO-8601 timestamp of the accepted POST."),
});

export type AttestationRecordData = z.infer<typeof AttestationRecordSchema>;

export const PullRequestSchema = z.object({
  url: z.string().min(1).describe(
    "Canonical URL of the pull request. Opaque to the model — the agent " +
      "supplies whatever URL their git host produced.",
  ),
  attempt: z.number().describe(
    "Sequential attempt number. Starts at 1 on the first link_pr call, " +
      "incremented on each subsequent link_pr call after a pr_failed cycle.",
  ),
  linkedAt: z.string().describe(
    "ISO-8601 timestamp of when link_pr was called. Updated on every " +
      "subsequent link_pr call so the record reflects the latest link.",
  ),
  mergedAt: z.string().optional().describe(
    "ISO-8601 timestamp of when pr_merged was called. Set once.",
  ),
  failedAt: z.string().optional().describe(
    "ISO-8601 timestamp of when pr_failed was called. Cleared on next link_pr.",
  ),
  failureReason: z.string().optional().describe(
    "Why the PR failed (CI failure, review rejection, etc.). Cleared on next link_pr.",
  ),
});

export type PullRequestData = z.infer<typeof PullRequestSchema>;

export const SummarySchema = z.object({
  originalProblem: z.string().describe(
    "Plain-language restatement of the bug or feature request from the issue.",
  ),
  deliveredOutcome: z.string().describe(
    "Plain-language description of what was actually built or fixed.",
  ),
  outcomeMet: z.boolean().describe(
    "Whether the delivered outcome addresses the original problem.",
  ),
  summarizedAt: z.string(),
});
