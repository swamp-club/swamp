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
  CiResultsSchema,
  ClassificationSchema,
  ContextSchema,
  FeedbackSchema,
  FixDirectiveSchema,
  GlobalArgsSchema,
  type PlanData,
  PlanSchema,
  PlanStepSchema,
  type StateData,
  StateSchema,
  TRANSITIONS,
} from "./_lib/schemas.ts";
import { createTracker } from "./_lib/issue_tracker.ts";
import { createSwampClubClient } from "./_lib/swamp_club.ts";
import type { SwampClubClient } from "./_lib/swamp_club.ts";

const tracker = createTracker();

/** Extended global args type including optional swamp-club fields. */
type GlobalArgs = {
  repo: string;
  issueNumber: number;
  swampClubUrl?: string;
  swampClubApiKey?: string;
};

/** Get or create the swamp-club client (lazily, from globalArgs). */
async function getSwampClub(
  globalArgs: GlobalArgs,
  logger?: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warning: (msg: string, props: Record<string, unknown>) => void;
  },
): Promise<SwampClubClient | null> {
  if (_swampClub === undefined) {
    _swampClub = await createSwampClubClient(globalArgs, logger);
  }
  return _swampClub;
}
let _swampClub: SwampClubClient | null | undefined;

/**
 * Get the swamp-club client and ensure the issue exists.
 * Each method run is a separate process, so the issueId cache is lost.
 * This helper must be called before postLifecycleEntry/transitionStatus.
 */
async function ensureSwampClub(
  globalArgs: GlobalArgs,
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warning: (msg: string, props: Record<string, unknown>) => void;
  },
): Promise<SwampClubClient | null> {
  const sc = await getSwampClub(globalArgs, logger);
  if (!sc) return null;
  const id = await sc.ensureIssue({
    title: `Issue #${globalArgs.issueNumber}`,
    body: `GitHub issue #${globalArgs.issueNumber} in ${globalArgs.repo}`,
    type: "feature",
  });
  if (!id) return null;
  return sc;
}

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
  version: "2026.04.06.1",
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
  ],

  resources: {
    "state": {
      description: "Current lifecycle phase and metadata",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "context": {
      description: "Issue context fetched from GitHub",
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
    "ciResults": {
      description: "CI check results and review comments",
      schema: CiResultsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "fixDirective": {
      description: "Human-directed fix instructions",
      schema: FixDirectiveSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
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

    "tracker-available": {
      description:
        "Checks that the issue tracker backend is available and authenticated",
      labels: ["live"],
      execute: async () => {
        const result = await tracker.checkAvailability();
        if (result.available) return { pass: true };
        return { pass: false, errors: [result.error] };
      },
    },
  },

  methods: {
    start: {
      description: "Fetch issue context and begin lifecycle",
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
        const { repo, issueNumber } = context.globalArgs;
        const handles = [];

        const issue = await tracker.fetchIssue(repo, issueNumber);

        handles.push(
          await context.writeResource("context", "context-main", {
            title: issue.title,
            body: issue.body,
            labels: issue.labels,
            comments: issue.comments,
            fetchedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "triaging",
            issueNumber,
            repo,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info("Fetched issue #{issueNumber}: {title}", {
          issueNumber,
          title: issue.title,
        });

        await tracker.postComment(
          repo,
          issueNumber,
          `\u{1F50D} **Triage started** \u2014 fetching issue context`,
        );
        const sc = await getSwampClub(context.globalArgs, context.logger);
        if (sc) {
          await sc.ensureIssue({
            title: issue.title,
            body: issue.body,
            type: "feature",
          });
          await sc.postLifecycleEntry({
            step: "triage_started",
            targetStatus: "open",
            summary: "Triage started",
            emoji: "\u{1F50D}",
            payload: { issueNumber, repo },
            isVerbose: false,
          });
        }
        await tracker.setPhaseLabel(repo, issueNumber, "triaging");

        return { dataHandles: handles };
      },
    },

    triage: {
      description: "Classify the issue based on context",
      arguments: z.object({
        type: z.enum(["bug", "feature", "regression", "unclear"]),
        confidence: z.enum(["high", "medium", "low"]),
        reasoning: z.string(),
        clarifyingQuestions: z.array(z.string()).optional(),
      }),
      execute: async (
        args: {
          type: "bug" | "feature" | "regression" | "unclear";
          confidence: "high" | "medium" | "low";
          reasoning: string;
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
        const { repo, issueNumber } = context.globalArgs;
        const handles = [];

        handles.push(
          await context.writeResource(
            "classification",
            "classification-main",
            {
              type: args.type,
              confidence: args.confidence,
              reasoning: args.reasoning,
              clarifyingQuestions: args.clarifyingQuestions,
              classifiedAt: new Date().toISOString(),
            },
          ),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "classified",
            issueNumber,
            repo,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info(
          "Classified as {type} ({confidence}): {reasoning}",
          {
            type: args.type,
            confidence: args.confidence,
            reasoning: args.reasoning,
          },
        );

        await tracker.postComment(
          repo,
          issueNumber,
          [
            `\u{1F4CB} **Classified as ${args.type}** (${args.confidence})`,
            "",
            "<details>",
            "<summary>Classification details</summary>",
            "",
            args.reasoning,
            "</details>",
          ].join("\n"),
        );
        const scClassify = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        if (scClassify) {
          await scClassify.postLifecycleEntry({
            step: "classified",
            targetStatus: "triaged",
            summary: `Classified as ${args.type} (${args.confidence})`,
            emoji: "\u{1F4CB}",
            payload: {
              type: args.type,
              confidence: args.confidence,
              reasoning: args.reasoning,
              clarifyingQuestions: args.clarifyingQuestions,
            },
            isVerbose: false,
          });
          await scClassify.transitionStatus("triaged");
        }
        await tracker.setPhaseLabel(repo, issueNumber, "classified");

        const typeLabels: Record<string, { add: string[]; remove: string[] }> =
          {
            bug: {
              add: ["bug"],
              remove: ["feature", "regression", "needs-triage"],
            },
            feature: {
              add: ["feature"],
              remove: ["bug", "regression", "needs-triage"],
            },
            regression: {
              add: ["bug", "regression"],
              remove: ["feature", "needs-triage"],
            },
            unclear: {
              add: ["lifecycle/needs-info"],
              remove: ["bug", "regression", "needs-triage"],
            },
          };
        const labelOps = typeLabels[args.type];
        if (labelOps) {
          await tracker.removeLabels(repo, issueNumber, labelOps.remove);
          await tracker.addLabels(repo, issueNumber, labelOps.add);
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
        const { repo, issueNumber } = context.globalArgs;
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
            repo,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info("Plan v1 generated: {summary}", {
          summary: args.summary,
        });

        await tracker.postComment(
          repo,
          issueNumber,
          [
            `\u{1F4DD} **Implementation plan generated** (v1)`,
            "",
            "<details>",
            "<summary>Plan summary</summary>",
            "",
            args.summary,
            "</details>",
          ].join("\n"),
        );
        const scPlan = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        await scPlan?.postLifecycleEntry({
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
        await tracker.setPhaseLabel(repo, issueNumber, "plan_generated");

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
        const { repo, issueNumber } = context.globalArgs;
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
            repo,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info(
          "Plan revised to v{version}, incorporated feedback round {round}",
          { version: newVersion, round: feedbackRound },
        );

        await tracker.postComment(
          repo,
          issueNumber,
          [
            `\u{1F504} **Plan revised** (v${newVersion}) \u2014 incorporated feedback round ${feedbackRound}`,
            "",
            "<details>",
            "<summary>Updated plan summary</summary>",
            "",
            args.summary,
            "</details>",
          ].join("\n"),
        );
        const scIterate = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        await scIterate?.postLifecycleEntry({
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
        await tracker.setPhaseLabel(repo, issueNumber, "plan_generated");

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
        const { repo, issueNumber } = context.globalArgs;
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

        const findingsText = findings
          .map((f) =>
            `- **${f.id}** [${f.severity}/${f.category}]: ${f.description}`
          )
          .join("\n");

        const blockers = critical + high;
        const status = blockers > 0
          ? `\u{1F6D1} **${blockers} blocking finding(s)** must be resolved before approval`
          : "\u{2705} No blocking findings — ready for approval";

        const severitySummary = [
          critical > 0 ? `${critical} critical` : "",
          high > 0 ? `${high} high` : "",
          medium > 0 ? `${medium} medium` : "",
          low > 0 ? `${low} low` : "",
        ].filter(Boolean).join(", ");

        await tracker.postComment(
          repo,
          issueNumber,
          [
            `\u{1F50D} **Adversarial review** (plan v${planVersion})`,
            "",
            status,
            "",
            "<details>",
            `<summary>Findings (${severitySummary})</summary>`,
            "",
            findingsText,
            "</details>",
          ].join("\n"),
        );
        const scReview = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        await scReview?.postLifecycleEntry({
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
        const { repo, issueNumber } = context.globalArgs;
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

        const resolvedText = args.resolutions
          .map((r) => `- **${r.findingId}**: ${r.resolutionNote}`)
          .join("\n");

        const remainingStatus = remaining > 0
          ? `\u{1F6D1} ${remaining} blocking finding(s) remain`
          : "\u{2705} All blocking findings resolved — ready for approval";

        await tracker.postComment(
          repo,
          issueNumber,
          [
            `\u{2705} **Findings resolved** (${resolved})`,
            "",
            remainingStatus,
            "",
            "<details>",
            "<summary>Resolution details</summary>",
            "",
            resolvedText,
            "</details>",
          ].join("\n"),
        );
        const scResolve = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        await scResolve?.postLifecycleEntry({
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
      description: "Approve the current plan and post it to the issue",
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
        const { repo, issueNumber } = context.globalArgs;
        const handles = [];

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "approved",
            issueNumber,
            repo,
            updatedAt: new Date().toISOString(),
          }),
        );

        const plan = await context.readResource!("plan-main") as
          | PlanData
          | null;
        if (plan) {
          const steps = plan.steps
            .map((s) =>
              `${s.order}. ${s.description}${
                s.risks ? ` _(risk: ${s.risks})_` : ""
              }`
            )
            .join("\n");
          const files = plan.steps
            .flatMap((s) => s.files)
            .filter((f, i, a) => a.indexOf(f) === i)
            .map((f) => `- \`${f}\``)
            .join("\n");
          const challenges = plan.potentialChallenges.map((c) => `- ${c}`).join(
            "\n",
          );

          const fileCount = plan.steps
            .flatMap((s) => s.files)
            .filter((f, i, a) => a.indexOf(f) === i)
            .length;

          await tracker.postComment(
            repo,
            issueNumber,
            [
              "<!-- IMPLEMENTATION-PLAN -->",
              `## Approved Implementation Plan (v${plan.version})`,
              "",
              `**Summary:** ${plan.summary}`,
              "",
              "<details>",
              "<summary>DDD Analysis</summary>",
              "",
              plan.dddAnalysis,
              "</details>",
              "",
              "### Implementation Steps",
              steps,
              "",
              "<details>",
              `<summary>Files (${fileCount})</summary>`,
              "",
              files,
              "</details>",
              "",
              "<details>",
              "<summary>Testing Strategy</summary>",
              "",
              plan.testingStrategy,
              "</details>",
              "",
              "<details>",
              "<summary>Potential Challenges</summary>",
              "",
              challenges,
              "</details>",
              "",
              plan.feedbackIncorporated.length > 0
                ? `_Incorporated ${plan.feedbackIncorporated.length} round(s) of feedback._`
                : "",
              "",
              "_Approved via swamp @swamp/issue-lifecycle_",
            ].join("\n"),
          );
        }

        context.logger.info("Plan approved", {});
        await tracker.setPhaseLabel(repo, issueNumber, "approved");

        const scApprove = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        if (scApprove && plan) {
          await scApprove.postLifecycleEntry({
            step: "plan_approved",
            targetStatus: "in_progress",
            summary:
              `Plan approved (v${plan.version}) — implementation starting`,
            emoji: "\u{2705}",
            payload: {
              version: plan.version,
              summary: plan.summary,
              stepsCount: plan.steps.length,
            },
            isVerbose: true,
          });
          await scApprove.transitionStatus("in_progress");
        }

        return { dataHandles: handles };
      },
    },

    implement: {
      description: "Signal that implementation has started and track the PR",
      arguments: z.object({
        prNumber: z.number().optional().describe(
          "PR number if already created",
        ),
      }),
      execute: async (
        args: { prNumber?: number },
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
        const { repo, issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "implementing",
          issueNumber,
          repo,
          prNumber: args.prNumber,
          updatedAt: new Date().toISOString(),
        });

        const prText = args.prNumber ? ` \u2014 PR #${args.prNumber}` : "";
        context.logger.info("Implementation started{prText}", { prText });

        await tracker.postComment(
          repo,
          issueNumber,
          `\u{1F680} **Implementation started**${prText}`,
        );
        const scImpl = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        if (scImpl) {
          await scImpl.postLifecycleEntry({
            step: "implementation_started",
            targetStatus: "in_progress",
            summary: `Implementation started${prText}`,
            emoji: "\u{1F680}",
            payload: {
              prNumber: args.prNumber ?? null,
            },
            isVerbose: false,
          });
        }
        await tracker.setPhaseLabel(repo, issueNumber, "implementing");

        return { dataHandles: [stateHandle] };
      },
    },

    record_pr: {
      description: "Record the PR number after implementation has started",
      arguments: z.object({
        prNumber: z.number().describe("Pull request number"),
      }),
      execute: async (
        args: { prNumber: number },
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
        const { repo, issueNumber } = context.globalArgs;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "implementing",
          issueNumber,
          repo,
          prNumber: args.prNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info("Recorded PR #{prNumber}", {
          prNumber: args.prNumber,
        });

        await tracker.postComment(
          repo,
          issueNumber,
          `\u{1F517} **PR linked:** #${args.prNumber}`,
        );

        const sc = await ensureSwampClub(context.globalArgs, context.logger);
        if (sc) {
          await sc.postLifecycleEntry({
            step: "pr_linked",
            targetStatus: "in_progress",
            summary: `PR #${args.prNumber} linked to implementation`,
            emoji: "\u{1F517}",
            payload: { prNumber: args.prNumber },
            isVerbose: false,
          });
        }

        return { dataHandles: [stateHandle] };
      },
    },

    ci_status: {
      description: "Fetch CI results and review comments for the PR",
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
        const { repo, issueNumber } = context.globalArgs;
        const handles = [];

        const state = await context.readResource!("state-main") as
          | StateData
          | null;
        if (!state?.prNumber) {
          throw new Error(
            "No PR number recorded. Run 'record_pr' with --input prNumber=<N> first.",
          );
        }
        const prNumber = state.prNumber;

        const checkRuns = await tracker.fetchPrChecks(repo, prNumber);
        const reviews = await tracker.fetchPrReviews(repo, prNumber);

        handles.push(
          await context.writeResource("ciResults", "ciResults-main", {
            prNumber,
            checkRuns,
            reviews,
            fetchedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "ci_review",
            issueNumber,
            repo,
            prNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        const passed = checkRuns.filter((c) => c.status === "passed").length;
        const failed = checkRuns.filter((c) => c.status === "failed").length;
        context.logger.info("CI results: {passed} passed, {failed} failed", {
          passed,
          failed,
        });

        await tracker.postComment(
          repo,
          issueNumber,
          `\u{1F52C} **CI results**: ${passed} passed, ${failed} failed`,
        );
        const scCi = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        await scCi?.postLifecycleEntry({
          step: "ci_results",
          targetStatus: "in_progress",
          summary: `CI results: ${passed} passed, ${failed} failed`,
          emoji: "\u{1F52C}",
          payload: {
            passed,
            failed,
            checks: checkRuns,
            reviews,
          },
          isVerbose: true,
        });
        await tracker.setPhaseLabel(repo, issueNumber, "ci_review");

        return { dataHandles: handles };
      },
    },

    fix: {
      description: "Direct specific fixes based on CI/review feedback",
      arguments: z.object({
        directive: z.string().describe(
          'What to fix, e.g. "fix the CRITICAL issues from adversarial review"',
        ),
        targetReview: z.string().optional().describe(
          "Filter to a specific reviewer",
        ),
        targetSeverity: z.string().optional().describe(
          "Filter to a specific severity level",
        ),
      }),
      execute: async (
        args: {
          directive: string;
          targetReview?: string;
          targetSeverity?: string;
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
          };
          modelType: string;
          modelId: string;
        },
      ) => {
        const { repo, issueNumber } = context.globalArgs;
        const handles = [];

        const state = await context.readResource!("state-main") as
          | StateData
          | null;

        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        const fixRound =
          allData.filter((d) => d.name === "fixDirective-main").length + 1;
        const ciEntries = allData.filter((d) => d.name === "ciResults-main");
        const latestCiVersion = ciEntries.length > 0
          ? Math.max(...ciEntries.map((e) => e.version))
          : 0;

        handles.push(
          await context.writeResource("fixDirective", "fixDirective-main", {
            round: fixRound,
            directive: args.directive,
            targetReview: args.targetReview,
            targetSeverity: args.targetSeverity,
            ciResultsVersion: latestCiVersion,
            submittedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await context.writeResource("state", "state-main", {
            phase: "implementing",
            issueNumber,
            repo,
            prNumber: state?.prNumber,
            updatedAt: new Date().toISOString(),
          }),
        );

        context.logger.info("Fix directive recorded: {directive}", {
          directive: args.directive,
        });

        await tracker.postComment(
          repo,
          issueNumber,
          `\u{1F527} **Fixing**: ${args.directive}`,
        );
        const scFix = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        await scFix?.postLifecycleEntry({
          step: "fixing",
          targetStatus: "in_progress",
          summary: `Fixing: ${args.directive}`,
          emoji: "\u{1F527}",
          payload: {
            directive: args.directive,
            targetReview: args.targetReview,
            targetSeverity: args.targetSeverity,
          },
          isVerbose: false,
        });
        await tracker.setPhaseLabel(repo, issueNumber, "implementing");

        return { dataHandles: handles };
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
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
        },
      ) => {
        const { repo, issueNumber } = context.globalArgs;

        const state = await context.readResource!("state-main") as
          | StateData
          | null;

        const stateHandle = await context.writeResource("state", "state-main", {
          phase: "done",
          issueNumber,
          repo,
          prNumber: state?.prNumber,
          updatedAt: new Date().toISOString(),
        });

        context.logger.info("Issue lifecycle complete", {});

        await tracker.postComment(
          repo,
          issueNumber,
          `\u{2705} **Complete** \u2014 all checks passed`,
        );
        const scDone = await ensureSwampClub(
          context.globalArgs,
          context.logger,
        );
        if (scDone) {
          await scDone.postLifecycleEntry({
            step: "complete",
            targetStatus: "shipped",
            summary: "Complete \u2014 all checks passed",
            emoji: "\u{2705}",
            payload: { summary: "all checks passed" },
            isVerbose: false,
          });
          await scDone.transitionStatus("shipped");
        }
        await tracker.setPhaseLabel(repo, issueNumber, "done");

        return { dataHandles: [stateHandle] };
      },
    },
  },
};
