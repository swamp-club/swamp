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

import { assertEquals } from "@std/assert";
import {
  type AttestationEnvironment,
  buildAttestation,
  type RunRecord,
  selectPriorRunIds,
  type WorkflowDef,
} from "./build_attestation.ts";

const WORKFLOW: WorkflowDef = {
  jobs: [
    {
      name: "build-setup",
      steps: [{
        name: "checkout",
        task: { modelName: "build-setup-${{ run.id }}" },
      }],
    },
    {
      name: "build-static-analysis",
      steps: [{
        name: "lint",
        task: { modelName: "build-lint-${{ run.id }}" },
      }],
    },
    {
      name: "reviews-setup",
      steps: [{
        name: "checkout",
        task: { modelName: "review-setup-${{ run.id }}" },
      }],
    },
    {
      name: "reviews",
      steps: [
        {
          name: "code-review",
          task: {
            modelName: "review-code-${{ run.id }}",
            inputs: {
              run: "claude -p - --model claude-opus-4-6 --allowedTools Read",
            },
          },
        },
        {
          name: "ux-review",
          task: {
            modelName: "review-ux-${{ run.id }}",
            inputs: {
              run: "claude -p - --model claude-sonnet-4-6 --allowedTools Read",
            },
          },
        },
      ],
    },
    {
      name: "skills-setup",
      steps: [{
        name: "checkout",
        task: { modelName: "skills-setup-${{ run.id }}" },
      }],
    },
    {
      name: "skills",
      steps: [
        {
          name: "skill-review",
          task: { modelName: "skills-review-${{ run.id }}" },
        },
      ],
    },
    {
      name: "attest",
      steps: [
        {
          name: "build-attestation",
          task: { modelName: "submit-attest-${{ run.id }}" },
        },
      ],
    },
  ],
};

function environment(
  overrides: Partial<AttestationEnvironment> = {},
): AttestationEnvironment {
  return {
    commit: "abc123",
    branch: "fix/thing",
    workflow: WORKFLOW,
    configIntegrity: { claudeMd: "deadbeef" },
    denoVersion: "2.9.7",
    os: "darwin",
    arch: "aarch64",
    now: new Date("2026-09-21T12:02:15.000Z"),
    priorRuns: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "submit-change",
    status: "running",
    startedAt: "2026-09-21T12:00:00.000Z",
    inputs: { commit: "abc123", branch: "fix/thing", issue: 42 },
    jobs: [
      {
        name: "build-setup",
        status: "succeeded",
        steps: [{ name: "checkout", status: "succeeded", duration: 900 }],
      },
      {
        name: "build-static-analysis",
        status: "succeeded",
        steps: [{ name: "lint", status: "succeeded", duration: 2100 }],
      },
      {
        name: "reviews-setup",
        status: "succeeded",
        steps: [{ name: "checkout", status: "succeeded", duration: 1500 }],
      },
      {
        name: "reviews",
        status: "succeeded",
        steps: [
          { name: "code-review", status: "succeeded", duration: 87000 },
          {
            name: "ux-review",
            status: "skipped",
            skipReason: {
              kind: "guarded",
              expression: "!inputs.runReviews || files.size() == 0",
            },
          },
        ],
      },
      {
        name: "skills-setup",
        status: "succeeded",
        steps: [{ name: "checkout", status: "succeeded", duration: 1200 }],
      },
      {
        name: "skills",
        status: "succeeded",
        steps: [{ name: "skill-review", status: "succeeded", duration: 5200 }],
      },
      {
        name: "attest",
        status: "running",
        steps: [{ name: "build-attestation", status: "running" }],
      },
    ],
    ...overrides,
  };
}

Deno.test("buildAttestation: projects the run's own steps, durations and models", () => {
  const att = buildAttestation(run(), environment());

  assertEquals(att.workflowRunId, "run-1");
  assertEquals(att.generatedBy, "workflow-step");
  assertEquals(att.subject, { commit: "abc123", branch: "fix/thing" });

  const steps = att.steps as Array<Record<string, unknown>>;
  const lint = steps.find((s) => s.step === "lint")!;
  assertEquals(lint.model, "build-lint-run-1");
  assertEquals(lint.durationMs, 2100);
  assertEquals(lint.status, "succeeded");
});

Deno.test("buildAttestation: excludes the run's own attest machinery", () => {
  // The attest job is not a verification group. Including it would have the
  // attestation attest to the act of attesting.
  const steps = buildAttestation(run(), environment()).steps as Array<
    Record<string, unknown>
  >;

  assertEquals(steps.some((s) => s.job === "attest"), false);
  assertEquals(steps.length, 7);
});

Deno.test("buildAttestation: a review's verdict is its step status, not its prose", () => {
  const steps = buildAttestation(run(), environment()).steps as Array<
    Record<string, unknown>
  >;

  assertEquals(steps.find((s) => s.step === "code-review")!.verdict, "pass");
  // A skipped review has no verdict — nothing reviewed, nothing decided.
  assertEquals(steps.find((s) => s.step === "ux-review")!.verdict, undefined);
  // A build step is not a review and never carries one.
  assertEquals(steps.find((s) => s.step === "lint")!.verdict, undefined);
});

Deno.test("buildAttestation: records each skip's kind and expression", () => {
  const att = buildAttestation(run(), environment());
  const steps = att.steps as Array<Record<string, unknown>>;
  const ux = steps.find((s) => s.step === "ux-review")!;

  assertEquals(ux.skipKind, "guarded");
  assertEquals(ux.skipExpression, "!inputs.runReviews || files.size() == 0");

  const gate = att.gate as Record<string, unknown>;
  assertEquals(gate.stepsSkipped, 1);
  assertEquals(gate.skippedByKind, { guarded: 1 });
  assertEquals(gate.allPassed, true);
});

Deno.test("buildAttestation: names the reviewer each review ran under", () => {
  const reviewConfig = buildAttestation(run(), environment())
    .reviewConfig as Record<string, Record<string, unknown>>;

  assertEquals(reviewConfig["code-review"].model, "claude-opus-4-6");
  assertEquals(reviewConfig["code-review"].ran, true);
  assertEquals(reviewConfig["ux-review"].model, "claude-sonnet-4-6");
  assertEquals(reviewConfig["ux-review"].ran, false);
});

Deno.test("buildAttestation: a deselected group is distinguishable from a path-guard skip", () => {
  const deselected = run({
    inputs: {
      commit: "abc123",
      branch: "fix/thing",
      issue: 42,
      runSkills: false,
    },
    jobs: run().jobs.map((job) =>
      job.name === "skills-setup"
        ? {
          ...job,
          status: "succeeded",
          steps: [{
            name: "checkout",
            status: "skipped",
            skipReason: {
              kind: "guarded" as const,
              expression: "!inputs.runSkills",
            },
          }],
        }
        : job.name === "skills"
        ? {
          ...job,
          steps: [{
            name: "skill-review",
            status: "skipped",
            skipReason: {
              kind: "guarded" as const,
              expression: "!inputs.runSkills || files.size() == 0",
            },
          }],
        }
        : job
    ),
  });

  const groups = buildAttestation(deselected, environment()).groups as Array<
    Record<string, unknown>
  >;

  const skills = groups.find((g) => g.name === "verify-skills")!;
  assertEquals(skills.selected, false);
  assertEquals(skills.ran, false);
  assertEquals(skills.reason, "guard: !inputs.runSkills");

  // The reviews group ran; its one skip was the path guard's doing.
  const reviews = groups.find((g) => g.name === "verify-reviews")!;
  assertEquals(reviews.selected, true);
  assertEquals(reviews.ran, true);
  assertEquals(reviews.reason, undefined);
});

Deno.test("buildAttestation: a failed step fails the gate and carries its error", () => {
  const failed = run({
    jobs: run().jobs.map((job) =>
      job.name === "build-static-analysis"
        ? {
          ...job,
          status: "failed",
          steps: [{
            name: "lint",
            status: "failed",
            duration: 1800,
            error: "Command exited with code 1",
          }],
        }
        : job
    ),
  });

  const att = buildAttestation(failed, environment());
  const gate = att.gate as Record<string, unknown>;
  assertEquals(gate.allPassed, false);
  assertEquals(gate.stepsFailed, 1);

  const steps = att.steps as Array<Record<string, unknown>>;
  assertEquals(
    steps.find((s) => s.step === "lint")!.errorMessage,
    "Command exited with code 1",
  );
});

Deno.test("buildAttestation: timing measures from the run's start to now", () => {
  const timing = buildAttestation(run(), environment())
    .timing as Record<string, unknown>;

  assertEquals(timing.startedAt, "2026-09-21T12:00:00.000Z");
  assertEquals(timing.completedAt, "2026-09-21T12:02:15.000Z");
  assertEquals(timing.totalDurationMs, 135_000);
});

Deno.test("buildAttestation: a skip with no recorded reason says so", () => {
  // Runs persisted before skip reasons existed are legitimately silent. Saying
  // so beats an unqualified "skipped", which invites the reader to assume a
  // guard decided it.
  const silent = run({
    jobs: run().jobs.map((job) =>
      job.name === "reviews"
        ? {
          ...job,
          steps: [{ name: "ux-review", status: "skipped" }],
        }
        : job
    ),
  });

  const att = buildAttestation(silent, environment());
  const steps = att.steps as Array<Record<string, unknown>>;
  assertEquals(
    steps.find((s) => s.step === "ux-review")!.reason,
    "reason not recorded",
  );
  assertEquals(
    (att.gate as Record<string, unknown>).skippedByKind,
    { unrecorded: 1 },
  );
});

// ---------------------------------------------------------------------------
// Evidence carried forward across runs at the same commit
// ---------------------------------------------------------------------------

/** A run in which the named groups were deselected and skipped outright. */
function runWithDeselected(
  id: string,
  deselected: readonly string[],
): RunRecord {
  const base = run({ id });
  const prefixes: Record<string, string> = {
    runBuild: "build",
    runReviews: "reviews",
    runSkills: "skills",
  };
  const off = deselected.map((d) => prefixes[d]);

  return {
    ...base,
    inputs: {
      ...base.inputs,
      ...Object.fromEntries(deselected.map((d) => [d, false])),
    },
    jobs: base.jobs.map((job) =>
      off.some((p) => job.name.startsWith(p))
        ? {
          ...job,
          steps: job.steps.map((s) => ({
            name: s.name,
            status: "skipped",
            skipReason: {
              kind: "guarded" as const,
              expression: `!inputs.${
                deselected.find((d) => job.name.startsWith(prefixes[d]))
              }`,
            },
          })),
        }
        : job
    ),
  };
}

Deno.test("buildAttestation: deselecting every group does NOT pass the gate", () => {
  // Nothing ran. Before the gate required evidence per group, this produced
  // zero steps, zero failures and allPassed: true — an instant bypass of the
  // whole chain, and the cheapest thing anyone testing the pipeline would try.
  const att = buildAttestation(
    runWithDeselected("run-2", ["runBuild", "runReviews", "runSkills"]),
    environment(),
  );

  const gate = att.gate as Record<string, unknown>;
  assertEquals(gate.allPassed, false);
  assertEquals(gate.groupsWithEvidence, 0);
  assertEquals(gate.groupsTotal, 3);
});

Deno.test("buildAttestation: a deselected group carries forward from an earlier run at this commit", () => {
  // The legitimate re-run: a review flaked, so reviews are re-run on their own
  // at the same commit. Build and skills evidence from the earlier run is
  // exactly as good — it examined the same tree.
  const att = buildAttestation(
    runWithDeselected("run-2", ["runBuild", "runSkills"]),
    environment({ priorRuns: [run({ id: "run-1" })] }),
  );

  const gate = att.gate as Record<string, unknown>;
  assertEquals(gate.allPassed, true);
  assertEquals(gate.groupsWithEvidence, 3);

  const groups = att.groups as Array<Record<string, unknown>>;
  const build = groups.find((g) => g.name === "verify-build")!;
  assertEquals(build.ran, true);
  assertEquals(build.carriedForward, true);
  assertEquals(build.evidenceFrom, "run-1");

  const reviews = groups.find((g) => g.name === "verify-reviews")!;
  assertEquals(reviews.carriedForward, undefined);
  assertEquals(reviews.evidenceFrom, "run-2");
});

Deno.test("buildAttestation: carried steps name the run that recorded them", () => {
  const att = buildAttestation(
    runWithDeselected("run-2", ["runBuild"]),
    environment({ priorRuns: [run({ id: "run-1" })] }),
  );

  const steps = att.steps as Array<Record<string, unknown>>;
  const lint = steps.find((s) => s.step === "lint")!;
  assertEquals(lint.status, "succeeded");
  assertEquals(lint.fromRun, "run-1");
  // Model names embed the run id, so a carried step must be named with the
  // id of the run that actually executed it.
  assertEquals(lint.model, "build-lint-run-1");

  // A step from this run carries no provenance marker.
  assertEquals(steps.find((s) => s.step === "code-review")!.fromRun, undefined);
});

Deno.test("buildAttestation: a prior run that also skipped the group carries nothing", () => {
  const att = buildAttestation(
    runWithDeselected("run-3", ["runBuild"]),
    environment({
      priorRuns: [runWithDeselected("run-2", ["runBuild"])],
    }),
  );

  const gate = att.gate as Record<string, unknown>;
  assertEquals(gate.allPassed, false);

  const build = (att.groups as Array<Record<string, unknown>>)
    .find((g) => g.name === "verify-build")!;
  assertEquals(build.ran, false);
  assertEquals(build.evidenceFrom, undefined);
});

Deno.test("buildAttestation: a prior run that FAILED the group carries nothing", () => {
  // Carrying a failure forward would launder it into a pass on the next run.
  const failed = run({ id: "run-1" });
  const prior: RunRecord = {
    ...failed,
    jobs: failed.jobs.map((job) =>
      job.name === "build-static-analysis"
        ? {
          ...job,
          status: "failed",
          steps: [{ name: "lint", status: "failed", error: "exit 1" }],
        }
        : job
    ),
  };

  const att = buildAttestation(
    runWithDeselected("run-2", ["runBuild"]),
    environment({ priorRuns: [prior] }),
  );

  assertEquals((att.gate as Record<string, unknown>).allPassed, false);
});

Deno.test("buildAttestation: the newest passing prior run wins", () => {
  const att = buildAttestation(
    runWithDeselected("run-3", ["runBuild"]),
    // Newest first, as fetchPriorRuns supplies them.
    environment({ priorRuns: [run({ id: "run-2" }), run({ id: "run-1" })] }),
  );

  const build = (att.groups as Array<Record<string, unknown>>)
    .find((g) => g.name === "verify-build")!;
  assertEquals(build.evidenceFrom, "run-2");
});

Deno.test("buildAttestation: a path-guard skip still counts as the group having run", () => {
  // verify-skills with no skill files changed: setup succeeds, both steps skip
  // on the path guard. The group ran — it simply had nothing to do — so it
  // must not be treated as missing evidence.
  const att = buildAttestation(run(), environment());

  const skills = (att.groups as Array<Record<string, unknown>>)
    .find((g) => g.name === "verify-skills")!;
  assertEquals(skills.ran, true);
  assertEquals(skills.carriedForward, undefined);
  assertEquals((att.gate as Record<string, unknown>).allPassed, true);
});

// Regression tests for the carry-forward that never carried anything.
//
// `workflow history search --json` names the run `runId`; `workflow history
// get --json` names it `id`. The prior-run lookup read `id` from search
// results, so every row was dropped and no group's evidence was ever carried
// forward — the targeted re-run documented in verification-conventions.md
// could not work. The payload below is the real shape, captured from
// `swamp workflow history search --workflow submit-change --input commit=...`.
const SEARCH_PAYLOAD = JSON.stringify({
  query: "",
  results: [
    {
      runId: "ccc97d61-d8d7-4572-9916-a256af0909a5",
      workflowId: "c7841e84-7343-43b9-a537-eb3718f7da44",
      workflowName: "submit-change",
      status: "succeeded",
      startedAt: "2026-09-22T13:22:58.281Z",
    },
    {
      runId: "2c938637-0e4e-4dca-96b0-aae26d0302d6",
      workflowId: "c7841e84-7343-43b9-a537-eb3718f7da44",
      workflowName: "submit-change",
      status: "failed",
      startedAt: "2026-09-22T13:21:00.410Z",
    },
    {
      runId: "0d11fc95-6b55-4351-954e-e7df90fd9741",
      workflowId: "c7841e84-7343-43b9-a537-eb3718f7da44",
      workflowName: "submit-change",
      status: "failed",
      startedAt: "2026-09-22T13:14:33.959Z",
    },
  ],
});

Deno.test("selectPriorRunIds reads runId from a real search payload, newest first", () => {
  assertEquals(
    selectPriorRunIds(SEARCH_PAYLOAD, "no-such-run"),
    [
      "ccc97d61-d8d7-4572-9916-a256af0909a5",
      "2c938637-0e4e-4dca-96b0-aae26d0302d6",
      "0d11fc95-6b55-4351-954e-e7df90fd9741",
    ],
  );
});

Deno.test("selectPriorRunIds excludes the current run", () => {
  const ids = selectPriorRunIds(
    SEARCH_PAYLOAD,
    "ccc97d61-d8d7-4572-9916-a256af0909a5",
  );
  assertEquals(ids.includes("ccc97d61-d8d7-4572-9916-a256af0909a5"), false);
  assertEquals(ids.length, 2);
});

Deno.test("selectPriorRunIds still accepts an id-named field", () => {
  // `workflow history get` uses `id`. If the two commands are ever reconciled
  // on one name, this keeps working either way.
  const payload = JSON.stringify({
    results: [{ id: "abc", startedAt: "2026-09-22T13:00:00.000Z" }],
  });
  assertEquals(selectPriorRunIds(payload, "other"), ["abc"]);
});

Deno.test("selectPriorRunIds returns nothing for an unparseable or empty payload", () => {
  assertEquals(selectPriorRunIds("not json", "x"), []);
  assertEquals(selectPriorRunIds(JSON.stringify({ results: [] }), "x"), []);
});
