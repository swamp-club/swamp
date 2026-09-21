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
  type WorkflowDef,
} from "./build_attestation.ts";

const WORKFLOW: WorkflowDef = {
  jobs: [
    {
      name: "build-setup",
      steps: [{ name: "checkout", task: { modelName: "build-setup-${{ run.id }}" } }],
    },
    {
      name: "build-static-analysis",
      steps: [{ name: "lint", task: { modelName: "build-lint-${{ run.id }}" } }],
    },
    {
      name: "reviews-setup",
      steps: [{ name: "checkout", task: { modelName: "review-setup-${{ run.id }}" } }],
    },
    {
      name: "reviews",
      steps: [
        {
          name: "code-review",
          task: {
            modelName: "review-code-${{ run.id }}",
            inputs: { run: "claude -p - --model claude-opus-4-6 --allowedTools Read" },
          },
        },
        {
          name: "ux-review",
          task: {
            modelName: "review-ux-${{ run.id }}",
            inputs: { run: "claude -p - --model claude-sonnet-4-6 --allowedTools Read" },
          },
        },
      ],
    },
    {
      name: "skills-setup",
      steps: [{ name: "checkout", task: { modelName: "skills-setup-${{ run.id }}" } }],
    },
    {
      name: "skills",
      steps: [
        { name: "skill-review", task: { modelName: "skills-review-${{ run.id }}" } },
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
