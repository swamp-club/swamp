// Swamp, an Automation Framework Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify it under the terms
// of the GNU Affero General Public License version 3 as published by the Free
// Software Foundation, with the Swamp Extension and Definition Exception (found in
// the "COPYING-EXCEPTION" file).
//
// Swamp is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with Swamp. If not, see <https://www.gnu.org/licenses/>.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Global Arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  issueNumber: z.number().describe(
    "Swamp Club lab issue number (the issue must already exist in swamp-club)",
  ),
  swampClubUrl: z.string().optional().describe(
    "Swamp Club API base URL (defaults to https://swamp.club)",
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
  "done",
]);

export type Phase = z.infer<typeof Phase>;

/** Valid transitions: method name → allowed source phases */
export const TRANSITIONS: Record<string, Phase[]> = {
  start: [
    "created",
    "triaging",
    "classified",
    "plan_generated",
    "approved",
    "implementing",
  ],
  triage: ["triaging"],
  plan: ["classified"],
  iterate: ["plan_generated"],
  approve: ["plan_generated"],
  implement: ["approved"],
  adversarial_review: ["plan_generated"],
  resolve_findings: ["plan_generated"],
  complete: ["implementing"],
};

// ---------------------------------------------------------------------------
// Issue Classification Types
// ---------------------------------------------------------------------------

/** Issue types supported by swamp-club. */
export const IssueType = z.enum(["bug", "feature", "security"]);
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
