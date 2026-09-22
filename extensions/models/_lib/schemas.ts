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
  fast_forward: ["triaging", "classified"],
  plan: ["classified"],
  iterate: ["plan_generated"],
  approve: ["plan_generated"],
  implement: ["approved", "pr_failed"],
  adversarial_review: ["plan_generated"],
  resolve_findings: ["plan_generated", "approved"],
  code_conformance_review: ["implementing", "pr_failed"],
  justify_deviations: ["implementing", "pr_failed"],
  verify: ["implementing"],
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
// Verification Attestation Schema
// ---------------------------------------------------------------------------

/**
 * The document swamp-club stores and CI validates before a PR may merge.
 *
 * The shape was real long before this schema was: `.github/workflows/ci.yml`
 * reads two dozen specific paths out of it with `jq`, and
 * `agent-constraints/verification-conventions.md` tells an agent how to
 * assemble each one by hand. Between those two, nothing checked anything —
 * `post_attestation` took a string, `JSON.parse`d it, and posted whatever came
 * back, so a document missing `subject` entirely was accepted and CI reported
 * the mismatch after the PR was already public.
 *
 * This is that shape, written down once. `scripts/build_attestation.ts`
 * validates what it emits against it and `post_attestation` validates what it
 * is handed, so the contract is enforced where the document is produced and
 * again where it leaves the machine, rather than in bash on the far side.
 *
 * `postedBy` and `postedAt` are deliberately absent: swamp-club stamps those
 * on acceptance, so they appear on the stored attestation CI fetches but never
 * on the one being posted.
 */
export const AttestationStepSchema = z.object({
  job: z.string().min(1).describe("Workflow job the step belongs to."),
  step: z.string().min(1).describe("Step name within that job."),
  model: z.string().optional().describe(
    "Model the step ran under, reconstructed from the workflow definition at " +
      "the verified commit. Absent when the definition names none.",
  ),
  status: z.string().min(1).describe(
    "Status the run recorded. Anything other than `succeeded` or `skipped` " +
      "counts against the gate — a step left `unknown` by a crashed run is a " +
      "step nobody can vouch for.",
  ),
  durationMs: z.number().optional().describe(
    "Measured duration, taken from the run record. Never estimated.",
  ),
  verdict: z.string().optional().describe(
    "For a review step, the gate decision. The step's status is that " +
      "decision — check_review_verdict.ts sets both — so this is a restating " +
      "of the status, not a second reading of the reviewer's prose.",
  ),
  findings: z.number().optional().describe("Findings the review reported."),
  reason: z.string().optional().describe(
    "Why a skipped step did not run, rendered from its recorded skip reason.",
  ),
  skipKind: z.enum(["dependency", "guarded", "job_skipped"]).optional()
    .describe(
      "Machine-readable form of the same fact, so a consumer can tell a " +
        "path guard from a deselected group without parsing prose.",
    ),
  skipExpression: z.string().optional().describe(
    "The guard expression, when the skip was a guard.",
  ),
  errorMessage: z.string().optional().describe("Error from a failed step."),
}).passthrough();

export type AttestationStepData = z.infer<typeof AttestationStepSchema>;

export const AttestationSchema = z.object({
  version: z.literal("1").describe(
    "Attestation format version. CI refuses a version it does not know.",
  ),
  type: z.literal("verification-attestation"),

  generatedBy: z.string().optional().describe(
    "How the document was produced. `script` means " +
      "scripts/build_attestation.ts projected it from the run records; it is " +
      "a statement of origin, not a proof of one — the generator still runs " +
      "wherever the caller runs it.",
  ),

  subject: z.object({
    commit: z.string().min(1).describe(
      "The revision the verification examined, canonical and unabbreviated. " +
        "Deliberately unconstrained beyond non-empty: consumers compare it " +
        "as an opaque string, and pinning a format here would encode one " +
        "tool's spelling into a contract shared with CI and swamp-club — " +
        "wrong even for git, whose SHA-256 repositories use 64 characters " +
        "rather than 40. The generator resolves it; CI refuses the " +
        "attestation when it differs from the PR head.",
    ),
    branch: z.string().min(1).describe("Branch the verification ran on."),
  }),

  environment: z.object({
    denoVersion: z.string().optional(),
    os: z.string().optional(),
    arch: z.string().optional(),
    swampVersion: z.string().optional(),
  }).passthrough().describe("Where verification ran."),

  configIntegrity: z.object({
    claudeMd: z.string().optional(),
    agentsMd: z.string().optional(),
    prompts: z.record(z.string(), z.string()).optional(),
    workflows: z.record(z.string(), z.string()).optional(),
    scripts: z.record(z.string(), z.string()).optional(),
  }).passthrough().describe(
    "SHA-256 of each file that shaped the verification, read at the verified " +
      "commit. CI re-hashes the same files and compares, which is what " +
      "catches a prompt or workflow edited after the run was launched. " +
      "Individual entries are optional because CI warns rather than fails on " +
      "an absent one.",
  ),

  reviewConfig: z.record(
    z.string(),
    z.object({
      model: z.string().optional().describe(
        "The claude model the review was invoked with.",
      ),
      ran: z.boolean(),
      reason: z.string().optional().describe(
        "Why it did not run. Derived from the step's persisted skip reason, " +
          "which is what separates a path guard from a deselected group.",
      ),
    }).passthrough(),
  ).optional().describe("Per-review model and whether it ran."),

  steps: z.array(AttestationStepSchema).describe(
    "Every verification step across the runs this attestation covers. " +
      "Excludes each workflow's own machinery — checkout, diff detection and " +
      "worktree cleanup are how verification is set up, not verification.",
  ),

  gate: z.object({
    allPassed: z.boolean().describe(
      "The verdict CI reads. True only when no step failed and every " +
        "workflow this attestation covers actually produced evidence.",
    ),
    stepsCompleted: z.number(),
    stepsTotal: z.number(),
    stepsSkipped: z.number(),
    stepsFailed: z.number().optional(),
    skippedByKind: z.record(z.string(), z.number()).optional().describe(
      "Skip counts broken out by kind, so a reader can tell guard-excluded " +
        "steps from ones whose dependency never ran.",
    ),
  }),

  timing: z.object({
    startedAt: z.string().optional(),
    completedAt: z.string().optional().describe(
      "When verification finished. CI measures its freshness window from it.",
    ),
    totalDurationMs: z.number().optional(),
  }).passthrough(),

  runs: z.record(z.string(), z.string()).optional().describe(
    "Workflow run id per verification workflow, so a reader can go back to " +
      "the records this document was projected from.",
  ),
}).passthrough();

export type AttestationData = z.infer<typeof AttestationSchema>;

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
