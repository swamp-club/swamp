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
import {
  AdversarialFindingSchema,
  type AdversarialReviewData,
  AdversarialReviewSchema,
  ClassificationSchema,
  ContextSchema,
  FeedbackSchema,
  GlobalArgsSchema,
  IssueType,
  type PlanData,
  PlanSchema,
  PlanStepSchema,
  PR_COOLDOWN_MS,
  type PullRequestData,
  PullRequestSchema,
  type StateData,
  StateSchema,
  TRANSITIONS,
} from "./_lib/schemas.ts";
import { createSwampClubClient } from "./_lib/swamp_club.ts";

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

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@swamp/issue-lifecycle",
  version: "2026.04.09.1",
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
    "pullRequest": {
      description:
        "Pull request linked to the implementation. Single instance, " +
        "overwritten by subsequent link_pr calls so the record always " +
        "reflects the latest link.",
      schema: PullRequestSchema,
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
        if (state.phase !== "approved") {
          return {
            pass: false,
            errors: [
              "Plan must be approved before implementation can begin.",
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
  },

  methods: {
    start: {
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

        await sc.postLifecycleEntry({
          step: "triage_started",
          targetStatus: "open",
          summary: "Triage started",
          emoji: "\u{1F50D}",
          payload: { issueNumber },
          isVerbose: false,
        });

        return { dataHandles: handles };
      },
    },

    triage: {
      description: "Classify the issue based on context",
      arguments: z.object({
        type: IssueType,
        confidence: z.enum(["high", "medium", "low"]),
        reasoning: z.string(),
        isRegression: z.boolean().optional().describe(
          "True if this is a regression (something that previously worked). Implies type=bug.",
        ),
        clarifyingQuestions: z.array(z.string()).optional(),
      }),
      execute: async (
        args: {
          type: "bug" | "feature" | "security";
          confidence: "high" | "medium" | "low";
          reasoning: string;
          isRegression?: boolean;
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
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const handles = [];

        handles.push(
          await context.writeResource(
            "classification",
            "classification-main",
            {
              type: args.type,
              confidence: args.confidence,
              reasoning: args.reasoning,
              isRegression: args.isRegression,
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

        const regressionLabel = args.isRegression ? " (regression)" : "";
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
          await sc.updateType(args.type);
          await sc.postLifecycleEntry({
            step: "classified",
            targetStatus: "triaged",
            summary:
              `Classified as ${args.type}${regressionLabel} (${args.confidence})`,
            emoji: "\u{1F4CB}",
            payload: {
              type: args.type,
              confidence: args.confidence,
              reasoning: args.reasoning,
              isRegression: args.isRegression ?? false,
              clarifyingQuestions: args.clarifyingQuestions,
            },
            isVerbose: false,
          });
          await sc.transitionStatus("triaged");
        }

        return { dataHandles: handles };
      },
    },

    plan: {
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
        await sc?.postLifecycleEntry({
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
        await sc?.postLifecycleEntry({
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
        await sc?.postLifecycleEntry({
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
        await sc?.postLifecycleEntry({
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

    approve: {
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
          await sc.postLifecycleEntry({
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
          await sc.transitionStatus("in_progress");
        }

        return { dataHandles: handles };
      },
    },

    implement: {
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
        await sc?.postLifecycleEntry({
          step: "implementation_started",
          targetStatus: "in_progress",
          summary: "Implementation started",
          emoji: "\u{1F680}",
          payload: {},
          isVerbose: false,
        });

        return { dataHandles: [stateHandle] };
      },
    },

    link_pr: {
      description:
        "Link a pull request to the implementation. Idempotent — calling " +
        "again overwrites the recorded URL with the latest link. " +
        "Transitions the phase to pr_open if currently implementing.",
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
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();

        const prHandle = await context.writeResource(
          "pullRequest",
          "pullRequest-main",
          {
            url: args.url,
            linkedAt: now,
          },
        );

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "pr_open",
          issueNumber,
          updatedAt: now,
        });

        context.logger.info("PR linked: {url}", { url: args.url });

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await sc?.postLifecycleEntry({
          step: "pr_linked",
          targetStatus: "in_progress",
          summary: `PR linked: ${args.url}`,
          emoji: "\u{1F517}",
          payload: { url: args.url },
          isVerbose: false,
        });

        return { dataHandles: [prHandle, stateHandle] };
      },
    },

    pr_merged: {
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

        handles.push(
          await context.writeResource("pullRequest", "pullRequest-main", {
            url: prContent.url,
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

        context.logger.info("PR merged \u2014 awaiting release build", {});

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await sc?.postLifecycleEntry({
          step: "pr_merged",
          targetStatus: "in_progress",
          summary: `PR merged: ${prContent.url} \u2014 awaiting release`,
          emoji: "\u{1F389}",
          payload: { url: prContent.url, mergedAt: args.mergedAt ?? now },
          isVerbose: false,
        });

        return { dataHandles: handles };
      },
    },

    pr_failed: {
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

        handles.push(
          await context.writeResource("pullRequest", "pullRequest-main", {
            url: prContent.url,
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

        context.logger.info("PR failed: {reason}", { reason: args.reason });

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        await sc?.postLifecycleEntry({
          step: "pr_failed",
          targetStatus: "in_progress",
          summary: `PR failed: ${args.reason}`,
          emoji: "\u{274C}",
          payload: { url: prContent.url, reason: args.reason },
          isVerbose: false,
        });

        return { dataHandles: handles };
      },
    },

    ship: {
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
        },
      ) => {
        const { issueNumber } = context.globalArgs;
        const now = new Date().toISOString();

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "done",
          issueNumber,
          updatedAt: now,
        });

        context.logger.info("Shipped", {});

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc) {
          await sc.postLifecycleEntry({
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
          await sc.transitionStatus("shipped");
        }

        return { dataHandles: [stateHandle] };
      },
    },

    complete: {
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
        },
      ) => {
        const { issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "done",
          issueNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info("Issue lifecycle complete", {});

        const sc = await createSwampClubClient(
          context.globalArgs,
          context.logger,
        );
        if (sc) {
          await sc.postLifecycleEntry({
            step: "complete",
            targetStatus: "shipped",
            summary: "Complete",
            emoji: "\u{2705}",
            payload: {},
            isVerbose: false,
          });
          await sc.transitionStatus("shipped");
        }

        return { dataHandles: [stateHandle] };
      },
    },
  },
};
