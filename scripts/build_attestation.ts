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

/**
 * Builds the verification attestation from a submit-change run record.
 *
 * This runs as a step of the run it attests to. Every number in the output is
 * read back out of what the run already persisted — step statuses, durations,
 * skip reasons — or hashed out of the verified commit. Nothing is supplied by
 * whoever launched the run.
 *
 * That is the whole point. The attestation used to be assembled by the agent
 * from the run records it had just produced, which made "the agent that ran
 * verification" and "the author of the document attesting to it" the same
 * party; an agent writing its own attestation is indistinguishable from one
 * fabricating it. Here the run vouches for itself and the script has no way to
 * say anything the run did not record.
 *
 * Usage:
 *   deno run --allow-read --allow-run=git \
 *     scripts/build_attestation.ts \
 *       --run-file <run-json> --commit <sha> --branch <name>
 *
 * The attestation JSON is written to stdout and nothing else is, so a caller
 * can capture it directly. Diagnostics go to stderr.
 */

import { parseArgs } from "@std/cli/parse-args";
import { parse as parseYaml } from "@std/yaml";
import { computeChecksum } from "../src/domain/models/checksum.ts";

/** The workflow file, relative to the repo root. */
const WORKFLOW_PATH = "verification/workflow-submit-change.yaml";

/**
 * Files whose content the attestation pins, keyed by the path the consumer
 * uses to look each hash up. CI re-hashes the same files at the same commit
 * and compares, so this list and the `check_hash` calls in `.github/workflows/
 * ci.yml` have to stay in step.
 */
const CONFIG_FILES: ReadonlyArray<{ path: string; jsonPath: string[] }> = [
  { path: "CLAUDE.md", jsonPath: ["claudeMd"] },
  { path: "AGENTS.md", jsonPath: ["agentsMd"] },
  {
    path: "verification/review-prompts/code-review.md",
    jsonPath: ["prompts", "code-review"],
  },
  {
    path: "verification/review-prompts/adversarial-review.md",
    jsonPath: ["prompts", "adversarial-review"],
  },
  {
    path: "verification/review-prompts/ux-review.md",
    jsonPath: ["prompts", "ux-review"],
  },
  {
    path: "verification/review-prompts/ci-security-review.md",
    jsonPath: ["prompts", "ci-security-review"],
  },
  { path: WORKFLOW_PATH, jsonPath: ["workflows", "submit-change"] },
  { path: "scripts/review_skills.ts", jsonPath: ["scripts", "review-skills"] },
  {
    path: "evals/promptfoo/package.json",
    jsonPath: ["scripts", "eval-skill-triggers"],
  },
  {
    path: "scripts/check_review_verdict.ts",
    jsonPath: ["scripts", "check-review-verdict"],
  },
  {
    path: "scripts/build_attestation.ts",
    jsonPath: ["scripts", "build-attestation"],
  },
];

/**
 * Job-name prefix → the boolean input that selects that group, and the setup
 * job whose skip means the whole group was deselected.
 */
const GROUPS: ReadonlyArray<{
  name: string;
  jobPrefix: string;
  input: string;
  setupJob: string;
}> = [
  {
    name: "verify-build",
    jobPrefix: "build-",
    input: "runBuild",
    setupJob: "build-setup",
  },
  {
    name: "verify-reviews",
    jobPrefix: "reviews",
    input: "runReviews",
    setupJob: "reviews-setup",
  },
  {
    name: "verify-skills",
    jobPrefix: "skills",
    input: "runSkills",
    setupJob: "skills-setup",
  },
];

/** The reviews job's steps, in the order the attestation lists them. */
const REVIEW_JOB = "reviews";

// -- Run record shapes (the subset this script reads) ------------------------

interface SkipReason {
  kind: "dependency" | "guarded" | "job_skipped";
  expression?: string;
}

interface StepRecord {
  name: string;
  status: string;
  error?: string;
  duration?: number;
  skipReason?: SkipReason;
}

interface JobRecord {
  name: string;
  status: string;
  steps: StepRecord[];
}

interface RunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
  inputs?: Record<string, unknown>;
  jobs: JobRecord[];
}

// -- Workflow definition shapes ---------------------------------------------

interface WorkflowStepDef {
  name?: string;
  task?: { modelName?: string; inputs?: { run?: string } };
}

interface WorkflowJobDef {
  name?: string;
  steps?: WorkflowStepDef[];
}

interface WorkflowDef {
  jobs?: WorkflowJobDef[];
}

// -- Helpers ----------------------------------------------------------------

/**
 * Reads a file as it stands at the verified commit, not as it stands in the
 * working tree. The two differ exactly when someone edits a prompt or a
 * workflow after launching verification, which is the case config integrity
 * exists to catch.
 */
async function showAtCommit(
  commit: string,
  path: string,
): Promise<Uint8Array | null> {
  const cmd = new Deno.Command("git", {
    args: ["show", `${commit}:${path}`],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  return code === 0 ? stdout : null;
}

function setIn(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = value;
}

function groupFor(jobName: string) {
  return GROUPS.find((g) => jobName.startsWith(g.jobPrefix));
}

/** One-line rendering of why a step did not run. */
function describeSkip(reason: SkipReason | undefined): string {
  if (!reason) return "reason not recorded";
  switch (reason.kind) {
    case "guarded":
      return reason.expression
        ? `guard: ${reason.expression}`
        : "guard excluded the step";
    case "dependency":
      return "dependency condition not met";
    case "job_skipped":
      return "job was skipped";
  }
}

/**
 * The model name the step ran under, from the workflow definition at the
 * verified commit with `${{ run.id }}` substituted. The run record does not
 * carry it, and reconstructing it from the definition ties the name in the
 * attestation to the file whose hash the attestation also pins.
 */
function modelNames(
  workflow: WorkflowDef,
  runId: string,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const job of workflow.jobs ?? []) {
    for (const step of job.steps ?? []) {
      const template = step.task?.modelName;
      if (!job.name || !step.name || !template) continue;
      names.set(
        `${job.name}:${step.name}`,
        template.replaceAll("${{ run.id }}", runId),
      );
    }
  }
  return names;
}

/**
 * The claude model each review was invoked with, read out of the review step's
 * own shell at the verified commit. Recorded so the attestation says which
 * reviewer produced the verdict, not merely that a review ran.
 */
function reviewModels(workflow: WorkflowDef): Map<string, string> {
  const models = new Map<string, string>();
  const job = (workflow.jobs ?? []).find((j) => j.name === REVIEW_JOB);
  for (const step of job?.steps ?? []) {
    const match = step.task?.inputs?.run?.match(/--model\s+(\S+)/);
    if (step.name && match) models.set(step.name, match[1]);
  }
  return models;
}

// -- Attestation ------------------------------------------------------------

/** Everything the attestation needs that does not come out of the run record. */
export interface AttestationEnvironment {
  commit: string;
  branch: string;
  workflow: WorkflowDef;
  configIntegrity: Record<string, unknown>;
  denoVersion: string;
  os: string;
  arch: string;
  now: Date;
}

/**
 * Projects a run record into the attestation document.
 *
 * Pure: every field is a function of the run record, the workflow definition
 * at the verified commit, and hashes of that commit's files. There is no
 * parameter through which a caller could assert something the run did not
 * record.
 */
export function buildAttestation(
  run: RunRecord,
  env: AttestationEnvironment,
): Record<string, unknown> {
  const { commit, branch, workflow } = env;
  const models = modelNames(workflow, run.id);
  const reviewers = reviewModels(workflow);

  // The attestation covers the verification groups. The jobs that build,
  // publish and open are the run's own machinery — including them would have
  // the attestation attest to the act of attesting.
  const verificationJobs = run.jobs.filter((j) => groupFor(j.name));

  const steps = verificationJobs.flatMap((job) =>
    job.steps.map((step) => ({
      job: job.name,
      step: step.name,
      model: models.get(`${job.name}:${step.name}`),
      status: step.status,
      durationMs: step.duration,
      // A review step's status IS the gate decision: every review delegates to
      // check_review_verdict.ts, whose exit code decides the step. Reading a
      // verdict out of the reviewer's prose would be reading the input to that
      // decision rather than the decision.
      verdict: job.name === REVIEW_JOB && step.status === "succeeded"
        ? "pass"
        : undefined,
      skipKind: step.status === "skipped" ? step.skipReason?.kind : undefined,
      skipExpression: step.status === "skipped"
        ? step.skipReason?.expression
        : undefined,
      reason: step.status === "skipped" ? describeSkip(step.skipReason) : undefined,
      errorMessage: step.status === "failed" ? step.error : undefined,
    }))
  );

  const succeeded = steps.filter((s) => s.status === "succeeded").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  // Anything that is neither succeeded nor skipped counts against the gate,
  // not just `failed`. A step left `unknown` by a crashed run, or still
  // `running`, is a step nobody can vouch for, and a gate that only looks for
  // `failed` would pass it.
  const failed = steps.length - succeeded - skipped;

  const skippedByKind: Record<string, number> = {};
  for (const step of steps) {
    if (step.status !== "skipped") continue;
    const kind = step.skipKind ?? "unrecorded";
    skippedByKind[kind] = (skippedByKind[kind] ?? 0) + 1;
  }

  // Which groups actually ran. A group's setup step is guarded by its flag
  // alone, so its status separates "the operator deselected this group" from
  // "a path guard excluded one review inside it" — a distinction a bare skip
  // count cannot carry, and the one a reader of the attestation needs.
  const groups = GROUPS.map((group) => {
    const setup = run.jobs.find((j) => j.name === group.setupJob)?.steps?.[0];
    const selected = run.inputs?.[group.input] !== false;
    return {
      name: group.name,
      input: group.input,
      selected,
      ran: setup?.status === "succeeded",
      reason: setup?.status === "skipped"
        ? describeSkip(setup.skipReason)
        : undefined,
    };
  });

  const reviewConfig: Record<string, unknown> = {};
  const reviewsJob = run.jobs.find((j) => j.name === REVIEW_JOB);
  for (const step of reviewsJob?.steps ?? []) {
    reviewConfig[step.name] = {
      model: reviewers.get(step.name),
      ran: step.status === "succeeded",
      reason: step.status === "skipped"
        ? describeSkip(step.skipReason)
        : undefined,
    };
  }

  // The run is still in flight — this step is one of its steps — so it has no
  // completedAt of its own to quote. `completedAt` is the moment verification
  // finished, which is now, and that is what CI's freshness window measures.
  const completedAt = env.now;
  const startedAt = run.startedAt ? new Date(run.startedAt) : undefined;

  return {
    version: "1",
    type: "verification-attestation",
    workflowRunId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    // Stated, not inferred: this document was produced by a step of the run it
    // describes. A consumer that cares can check the generator against the
    // build-attestation hash under configIntegrity.
    generatedBy: "workflow-step",

    subject: { commit, branch },

    environment: {
      denoVersion: env.denoVersion,
      os: env.os,
      arch: env.arch,
    },

    configIntegrity: env.configIntegrity,
    groups,
    reviewConfig,
    steps,

    gate: {
      allPassed: failed === 0,
      stepsCompleted: succeeded,
      stepsTotal: steps.length,
      stepsSkipped: skipped,
      stepsFailed: failed,
      skippedByKind,
    },

    timing: {
      startedAt: startedAt?.toISOString(),
      completedAt: completedAt.toISOString(),
      totalDurationMs: startedAt
        ? completedAt.getTime() - startedAt.getTime()
        : undefined,
    },
  };
}

// -- Main -------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ["run-file", "commit", "branch"],
  });

  const runFile = args["run-file"];
  const commit = args.commit;
  const branch = args.branch;
  if (!runFile || !commit || !branch) {
    console.error(
      "usage: build_attestation.ts --run-file <json> --commit <sha> --branch <name>",
    );
    return 2;
  }

  const run = JSON.parse(await Deno.readTextFile(runFile)) as RunRecord;

  // Commit binding. The run was launched with a commit and every group checked
  // out that commit; an attestation naming a different one would be attesting
  // to work nobody did. Cheap to check here, impossible to check afterwards.
  const runCommit = run.inputs?.["commit"];
  if (runCommit !== commit) {
    console.error(
      `::error::attestation commit ${commit} does not match the run's ` +
        `commit ${String(runCommit)} — refusing to attest`,
    );
    return 1;
  }

  const workflowSource = await showAtCommit(commit, WORKFLOW_PATH);
  if (!workflowSource) {
    console.error(
      `::error::${WORKFLOW_PATH} not found at ${commit} — cannot resolve ` +
        "step model names or review models",
    );
    return 1;
  }
  const workflow = parseYaml(
    new TextDecoder().decode(workflowSource),
  ) as WorkflowDef;

  const configIntegrity: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const file of CONFIG_FILES) {
    const bytes = await showAtCommit(commit, file.path);
    if (!bytes) {
      missing.push(file.path);
      continue;
    }
    setIn(configIntegrity, file.jsonPath, await computeChecksum(bytes));
  }
  if (missing.length > 0) {
    // A warning, not a failure: a file legitimately absent at an older commit
    // must not block the attestation, and CI reports a missing hash as a
    // warning of its own.
    console.error(
      `::warning::not present at ${commit}, hash omitted: ${
        missing.join(", ")
      }`,
    );
  }

  const attestation = buildAttestation(run, {
    commit,
    branch,
    workflow,
    configIntegrity,
    denoVersion: Deno.version.deno,
    os: Deno.build.os,
    arch: Deno.build.arch,
    now: new Date(),
  });

  console.log(JSON.stringify(attestation));
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}

export { main };
export type { RunRecord, WorkflowDef };
