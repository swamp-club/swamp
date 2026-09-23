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

// `buildAttestation` is pure so the document's shape can be pinned without a
// run, a git checkout or a swamp-club. These tests are the only automated
// coverage this script has: `scripts/` is excluded from `deno fmt` and
// `deno lint` in deno.json, and `deno run check` only type-checks the main.ts
// graph.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildAttestation,
  checkCommitBinding,
  checkWorkflowProvenance,
  describeSkip,
  evaluatedWorkflowPath,
  matchRunsToWorkflows,
  modelNames,
  reviewModels,
  type RunRecord,
  type RunSource,
  type WorkflowDef,
} from "./build_attestation.ts";
import { join } from "@std/path";
import { AttestationSchema } from "../extensions/models/_lib/schemas.ts";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";

const COMMIT = "a".repeat(40);

function env(overrides: Record<string, unknown> = {}) {
  return {
    commit: COMMIT,
    branch: "some-branch",
    configIntegrity: { claudeMd: "hash-of-claude-md" },
    denoVersion: "2.9.7",
    swampVersion: "0.1.0",
    os: "linux",
    arch: "x86_64",
    now: new Date("2026-09-22T12:00:00.000Z"),
    ...overrides,
  };
}

/** A run record with the machinery jobs every verify-* workflow has. */
function run(
  workflowName: string,
  id: string,
  jobs: RunRecord["jobs"],
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return {
    id,
    workflowName,
    startedAt: "2026-09-22T11:00:00.000Z",
    duration: 60 * 1000,
    inputs: { commit: COMMIT, branch: "some-branch" },
    jobs: [
      { name: "setup", steps: [{ name: "checkout", status: "succeeded" }] },
      ...jobs,
      {
        name: "cleanup",
        steps: [{ name: "remove-worktree", status: "succeeded" }],
      },
    ],
    ...overrides,
  };
}

const BUILD_DEF: WorkflowDef = {
  jobs: [
    {
      name: "static-analysis",
      steps: [
        { name: "lint", task: { modelName: "build-lint-${{ run.id }}" } },
      ],
    },
  ],
};

const REVIEWS_DEF: WorkflowDef = {
  jobs: [
    {
      name: "reviews",
      steps: [
        {
          name: "code-review",
          task: {
            modelName: "review-code-${{ run.id }}",
            inputs: { run: "claude -p - --model claude-opus-4-6 --foo" },
          },
        },
        {
          name: "ux-review",
          task: {
            modelName: "review-ux-${{ run.id }}",
            inputs: { run: "claude -p - --model claude-sonnet-4-6 --foo" },
          },
        },
      ],
    },
  ],
};

const SKILLS_DEF: WorkflowDef = {
  jobs: [
    {
      name: "skills",
      steps: [
        {
          name: "skill-review",
          task: { modelName: "skills-review-${{ run.id }}" },
        },
      ],
    },
  ],
};

/** The happy path: all three workflows, one review guarded out. */
function sources(): RunSource[] {
  return [
    {
      key: "build",
      name: "verify-build",
      definition: BUILD_DEF,
      run: run("verify-build", "run-build", [
        {
          name: "static-analysis",
          steps: [{ name: "lint", status: "succeeded", duration: 2100 }],
        },
      ]),
    },
    {
      key: "reviews",
      name: "verify-reviews",
      definition: REVIEWS_DEF,
      run: run("verify-reviews", "run-reviews", [
        {
          name: "detect-changes",
          steps: [{ name: "diff", status: "succeeded" }],
        },
        {
          name: "reviews",
          steps: [
            { name: "code-review", status: "succeeded", duration: 87000 },
            {
              name: "ux-review",
              status: "skipped",
              skipReason: { kind: "guarded", expression: "no UX changes" },
            },
          ],
        },
      ]),
    },
    {
      key: "skills",
      name: "verify-skills",
      definition: SKILLS_DEF,
      run: run("verify-skills", "run-skills", [
        {
          name: "skills",
          steps: [{ name: "skill-review", status: "succeeded", duration: 5200 }],
        },
      ]),
    },
  ];
}

Deno.test("buildAttestation: output validates against AttestationSchema", () => {
  const result = AttestationSchema.safeParse(
    buildAttestation(sources(), env()),
  );
  assert(
    result.success,
    `expected a schema-valid document, got: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`,
  );
});

Deno.test("buildAttestation: machinery jobs are not verification steps", () => {
  const doc = buildAttestation(sources(), env());
  const steps = doc.steps as Array<{ job: string; step: string }>;

  // setup / detect-changes / cleanup ran and succeeded in every run, so a
  // gate that counted them would read 3 steps higher and call checkout a
  // verification result.
  assertEquals(
    steps.map((s) => `${s.job}:${s.step}`),
    [
      "static-analysis:lint",
      "reviews:code-review",
      "reviews:ux-review",
      "skills:skill-review",
    ],
  );
});

Deno.test("buildAttestation: a review's verdict is its step status", () => {
  const doc = buildAttestation(sources(), env());
  const steps = doc.steps as Array<
    { step: string; verdict?: string; status: string }
  >;

  assertEquals(steps.find((s) => s.step === "code-review")?.verdict, "pass");
  // A skipped review has no verdict — it produced no decision to record.
  assertEquals(steps.find((s) => s.step === "ux-review")?.verdict, undefined);
  // A non-review step is not given one either.
  assertEquals(steps.find((s) => s.step === "lint")?.verdict, undefined);
});

Deno.test("buildAttestation: a guarded skip carries its reason and expression", () => {
  const doc = buildAttestation(sources(), env());
  const ux = (doc.steps as Array<
    { step: string; reason?: string; skipKind?: string }
  >).find((s) => s.step === "ux-review");

  assertEquals(ux?.skipKind, "guarded");
  assertEquals(ux?.reason, "guard: no UX changes");
  assertEquals(
    (doc.gate as { skippedByKind: Record<string, number> }).skippedByKind,
    { guarded: 1 },
  );
});

Deno.test("buildAttestation: a skip with no recorded reason says so", () => {
  const withBareSkip = sources();
  withBareSkip[0].run.jobs[1].steps[0] = { name: "lint", status: "skipped" };

  const doc = buildAttestation(withBareSkip, env());
  const lint = (doc.steps as Array<{ step: string; reason?: string }>).find(
    (s) => s.step === "lint",
  );

  // Runs persisted before skip reasons existed are legitimately silent, and
  // saying so beats inviting the reader to assume a guard.
  assertEquals(lint?.reason, "reason not recorded");
  assertEquals(
    (doc.gate as { skippedByKind: Record<string, number> }).skippedByKind
      .unrecorded,
    1,
  );
});

Deno.test("buildAttestation: reviewConfig reports model, ran and why not", () => {
  const doc = buildAttestation(sources(), env());

  assertEquals(doc.reviewConfig, {
    "code-review": {
      model: "claude-opus-4-6",
      ran: true,
      reason: undefined,
    },
    "ux-review": {
      model: "claude-sonnet-4-6",
      ran: false,
      reason: "guard: no UX changes",
    },
  });
});

Deno.test("buildAttestation: gate counts and passes when nothing failed", () => {
  const doc = buildAttestation(sources(), env());

  assertEquals(doc.gate, {
    allPassed: true,
    stepsCompleted: 3,
    stepsTotal: 4,
    stepsSkipped: 1,
    stepsFailed: 0,
    skippedByKind: { guarded: 1 },
  });
});

Deno.test("buildAttestation: a failed step fails the gate and keeps its error", () => {
  const failing = sources();
  failing[0].run.jobs[1].steps[0] = {
    name: "lint",
    status: "failed",
    error: "no-explicit-any",
  };

  const doc = buildAttestation(failing, env());
  const gate = doc.gate as { allPassed: boolean; stepsFailed: number };

  assertEquals(gate.allPassed, false);
  assertEquals(gate.stepsFailed, 1);
  assertEquals(
    (doc.steps as Array<{ step: string; errorMessage?: string }>).find((s) =>
      s.step === "lint"
    )?.errorMessage,
    "no-explicit-any",
  );
});

Deno.test("buildAttestation: a step left neither succeeded nor skipped counts against the gate", () => {
  const stalled = sources();
  stalled[0].run.jobs[1].steps[0] = { name: "lint", status: "unknown" };

  const gate = buildAttestation(stalled, env()).gate as {
    allPassed: boolean;
    stepsFailed: number;
  };

  // A crashed run leaves steps `unknown`. Nobody can vouch for those, and a
  // gate that only looked for `failed` would wave them through.
  assertEquals(gate.allPassed, false);
  assertEquals(gate.stepsFailed, 1);
});

Deno.test("buildAttestation: missing a workflow fails the gate even with no failures", () => {
  const twoOnly = sources().slice(0, 2);

  const gate = buildAttestation(twoOnly, env()).gate as {
    allPassed: boolean;
    stepsFailed: number;
  };

  // Every step present passed. Without the second gate condition this would
  // be a green attestation for a verification that never ran the skills
  // workflow at all.
  assertEquals(gate.stepsFailed, 0);
  assertEquals(gate.allPassed, false);
});

Deno.test("buildAttestation: model names carry the run that produced them", () => {
  const doc = buildAttestation(sources(), env());
  const steps = doc.steps as Array<{ step: string; model?: string }>;

  assertEquals(steps.find((s) => s.step === "lint")?.model, "build-lint-run-build");
  assertEquals(
    steps.find((s) => s.step === "code-review")?.model,
    "review-code-run-reviews",
  );
});

Deno.test("buildAttestation: timing spans the earliest start to the latest finish", () => {
  const staggered = sources();
  staggered[0].run.startedAt = "2026-09-22T11:30:00.000Z";
  staggered[0].run.duration = 10 * 60 * 1000;
  staggered[1].run.startedAt = "2026-09-22T11:00:00.000Z";
  staggered[1].run.duration = 5 * 60 * 1000;
  staggered[2].run.startedAt = "2026-09-22T11:15:00.000Z";
  staggered[2].run.duration = 60 * 1000;

  const timing = buildAttestation(staggered, env()).timing as {
    startedAt: string;
    completedAt: string;
    totalDurationMs: number;
  };

  // The three runs overlap, so summing their durations would describe a
  // wall-clock span nobody waited through. Earliest start is run 1 at 11:00;
  // latest finish is run 0, which started at 11:30 and took ten minutes.
  assertEquals(timing.startedAt, "2026-09-22T11:00:00.000Z");
  assertEquals(timing.completedAt, "2026-09-22T11:40:00.000Z");
  assertEquals(timing.totalDurationMs, 40 * 60 * 1000);
});

Deno.test("buildAttestation: completion comes from the runs, not the clock", () => {
  // `env.now` is an hour after the runs ended. The generator is invoked by
  // hand after the fact, so quoting the clock would put the moment the
  // document was written into a field meaning the moment verification
  // finished — and inflate the duration by the gap.
  const timing = buildAttestation(sources(), env()).timing as {
    completedAt: string;
    totalDurationMs: number;
  };

  assertEquals(timing.completedAt, "2026-09-22T11:01:00.000Z");
  assertEquals(timing.totalDurationMs, 60 * 1000);
});

Deno.test("buildAttestation: a run with no duration falls back to the clock", () => {
  const undated = sources();
  for (const source of undated) source.run.duration = undefined;

  const timing = buildAttestation(undated, env()).timing as {
    completedAt: string;
  };

  // Nothing in the records says when it ended, so claiming a completion they
  // do not support would be worse than naming the moment of writing.
  assertEquals(timing.completedAt, "2026-09-22T12:00:00.000Z");
});

Deno.test("buildAttestation: subject and runs name what was examined", () => {
  const doc = buildAttestation(sources(), env());

  assertEquals(doc.subject, { commit: COMMIT, branch: "some-branch" });
  assertEquals(doc.runs, {
    build: "run-build",
    reviews: "run-reviews",
    skills: "run-skills",
  });
  assertEquals(doc.generatedBy, "script");
});

Deno.test("matchRunsToWorkflows: the records say which run is which", () => {
  const given = sources().map((s) => s.run);
  // Deliberately out of order — the caller is not asked to label them.
  const matched = matchRunsToWorkflows([given[2], given[0], given[1]]);

  assert(!("error" in matched));
  assertEquals(matched.sources.map((s) => s.key), [
    "build",
    "reviews",
    "skills",
  ]);
});

Deno.test("matchRunsToWorkflows: a missing workflow is named", () => {
  const given = sources().map((s) => s.run);
  const matched = matchRunsToWorkflows([given[0], given[1]]);

  assert("error" in matched);
  assertStringIncludes(matched.error, "verify-skills");
});

Deno.test("matchRunsToWorkflows: two runs of one workflow is ambiguous", () => {
  const given = sources().map((s) => s.run);
  const second = { ...given[1], id: "run-reviews-again" };
  const matched = matchRunsToWorkflows([given[0], given[1], second, given[2]]);

  assert("error" in matched);
  assertStringIncludes(matched.error, "more than one verify-reviews run");
});

Deno.test("matchRunsToWorkflows: a run from another workflow is refused", () => {
  const given = sources().map((s) => s.run);
  const stray = run("nightly-build", "run-nightly", []);
  const matched = matchRunsToWorkflows([...given, stray]);

  assert("error" in matched);
  assertStringIncludes(matched.error, "nightly-build");
});

Deno.test("checkCommitBinding: a run of another commit is refused", () => {
  const given = sources();
  given[1].run.inputs = { commit: "b".repeat(40) };

  const errors = checkCommitBinding(given, COMMIT);

  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "verify-reviews");
  // Both identifiers in full. Truncating them to eight characters rendered a
  // SHA and its own abbreviation as the same string, so the message said
  // "verified cfc7d0eb, not cfc7d0eb" and told the reader nothing.
  assertStringIncludes(errors[0], "b".repeat(40));
  assertStringIncludes(errors[0], COMMIT);
});

Deno.test("checkCommitBinding: a run with no commit input cannot be bound", () => {
  const given = sources();
  given[0].run.inputs = {};

  const errors = checkCommitBinding(given, COMMIT);

  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "records no commit input");
});

Deno.test("checkCommitBinding: matching commits bind cleanly", () => {
  assertEquals(checkCommitBinding(sources(), COMMIT), []);
});

/** A committed setup job, as the workflow file spells it. */
function committedDefinition() {
  return {
    name: "verify-reviews",
    concurrency: 4,
    jobs: [{
      name: "setup",
      steps: [{
        name: "checkout",
        task: {
          modelName: "review-setup-${{ run.id }}",
          inputs: {
            run: "set -e\ngit fetch origin main || git fetch origin main\n" +
              'git worktree add --detach "$DIR" "${{ inputs.commit }}"\n',
          },
        },
      }],
    }],
  };
}

/** The same job as swamp records it after evaluating the run. */
function evaluatedDefinition() {
  return {
    name: "verify-reviews",
    concurrency: 4,
    jobs: [{
      name: "setup",
      dependsOn: [],
      weight: 0,
      steps: [{
        name: "checkout",
        dependsOn: [],
        weight: 0,
        allowFailure: false,
        task: {
          modelName: "review-setup-${{ run.id }}",
          inputs: {
            run: "set -e\ngit fetch origin main || git fetch origin main\n" +
              `git worktree add --detach "$DIR" "${COMMIT}"\n`,
          },
        },
      }],
    }],
  };
}

Deno.test("checkWorkflowProvenance: an evaluation of the committed file matches", () => {
  assertEquals(
    checkWorkflowProvenance(committedDefinition(), evaluatedDefinition()),
    [],
  );
});

Deno.test("checkWorkflowProvenance: a run of a different script is refused", () => {
  // The case that motivated the check: the runs loaded another checkout's
  // verification/ directory, whose setup step predates the committed one.
  const evaluated = evaluatedDefinition();
  evaluated.jobs[0].steps[0].task.inputs.run = "set -e\n" +
    "git fetch origin main\n" +
    `git worktree add --detach "$DIR" "${COMMIT}"\n`;

  const errors = checkWorkflowProvenance(committedDefinition(), evaluated);

  assertEquals(errors, [
    "jobs[0].steps[0].task.inputs.run differs from the committed definition",
  ]);
});

Deno.test("checkWorkflowProvenance: an expression cannot absorb literal text around it", () => {
  const evaluated = evaluatedDefinition();
  evaluated.jobs[0].steps[0].task.modelName = "reviewer-setup-run-1";

  const errors = checkWorkflowProvenance(committedDefinition(), evaluated);

  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "jobs[0].steps[0].task.modelName");
});

Deno.test("checkWorkflowProvenance: an extra step is refused", () => {
  const evaluated = evaluatedDefinition();
  evaluated.jobs[0].steps.push({ ...evaluated.jobs[0].steps[0] });

  const errors = checkWorkflowProvenance(committedDefinition(), evaluated);

  assertEquals(errors, [
    "jobs[0].steps has 2 entries where the committed definition has 1",
  ]);
});

Deno.test("checkWorkflowProvenance: a filled-in default is accepted, a set value is not", () => {
  const evaluated = evaluatedDefinition();
  evaluated.jobs[0].steps[0].allowFailure = true;

  const errors = checkWorkflowProvenance(committedDefinition(), evaluated);

  assertEquals(errors, [
    "jobs[0].steps[0].allowFailure is in the evaluated workflow but not the committed definition",
  ]);
});

Deno.test("checkWorkflowProvenance: a committed field the run lacks is refused", () => {
  const evaluated: Record<string, unknown> = evaluatedDefinition();
  delete evaluated.concurrency;

  assertEquals(
    checkWorkflowProvenance(committedDefinition(), evaluated),
    ["concurrency is missing from the evaluated workflow"],
  );
});

Deno.test("evaluatedWorkflowPath: found beside the run record", () => {
  const swampDir = join("repo", ".swamp");
  const record = run("verify-reviews", "run-1", [], {
    path: join(swampDir, "workflow-runs", "wf-id", "workflow-run-run-1.yaml"),
  });

  assertPathEquals(
    evaluatedWorkflowPath(record)!,
    join(swampDir, "workflows-evaluated", "runs", "run-1", "evaluated-workflow.yaml"),
  );
});

Deno.test("evaluatedWorkflowPath: a record with no path locates nothing", () => {
  assertEquals(evaluatedWorkflowPath(run("verify-reviews", "run-1", [])), null);
});

Deno.test("describeSkip: each kind reads as what it was", () => {
  assertEquals(
    describeSkip({ kind: "guarded", expression: "files.size() == 0" }),
    "guard: files.size() == 0",
  );
  assertEquals(describeSkip({ kind: "guarded" }), "guard excluded the step");
  assertEquals(
    describeSkip({ kind: "dependency" }),
    "dependency condition not met",
  );
  assertEquals(describeSkip({ kind: "job_skipped" }), "job was skipped");
  assertEquals(describeSkip(undefined), "reason not recorded");
});

Deno.test("modelNames: the run id is substituted into the template", () => {
  const names = modelNames(REVIEWS_DEF, "run-xyz");
  assertEquals(names.get("reviews:code-review"), "review-code-run-xyz");
});

Deno.test("reviewModels: the model comes out of the step's own shell", () => {
  const models = reviewModels(REVIEWS_DEF);
  assertEquals(models.get("code-review"), "claude-opus-4-6");
  assertEquals(models.get("ux-review"), "claude-sonnet-4-6");
});

Deno.test("reviewModels: a step that names no model yields none", () => {
  assertEquals(reviewModels(BUILD_DEF).size, 0);
});
