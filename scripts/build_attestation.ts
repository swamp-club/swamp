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
 * deno in --allow-run is a wide grant and the index child runs with
 * --allow-ffi, so it is not sandboxed; call sites pass fixed arguments and run
 * this repo's code at the attested commit
 */

import { parseArgs } from "@std/cli/parse-args";
import { dirname, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import type { InputsSchema } from "../src/domain/definitions/definition.ts";
import { InputValidationService } from "../src/domain/inputs/input_validation_service.ts";
import {
  extractExpressions,
  replaceExpressions,
} from "../src/domain/expressions/expression_parser.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import { computeChecksum } from "../src/domain/models/checksum.ts";
import {
  AttestationSchema,
  type AttestationStepData,
} from "../extensions/models/_lib/schemas.ts";
import {
  type AffectedCommands,
  buildImportGraph,
  COMMAND_DIR,
  type CommandIndex,
  computeAffectedCommands,
  type DenoInfo,
  ENTRY_POINT,
} from "./affected_commands.ts";

/**
 * key names the run under runs in the document and the workflow's hash under
 * configIntegrity.workflows
 */
const WORKFLOWS: ReadonlyArray<{
  key: string;
  name: string;
  path: string;
}> = [
  {
    key: "build",
    name: "verify-build",
    path: "verification/workflow-verify-build.yaml",
  },
  {
    key: "reviews",
    name: "verify-reviews",
    path: "verification/workflow-verify-reviews.yaml",
  },
  {
    key: "skills",
    name: "verify-skills",
    path: "verification/workflow-verify-skills.yaml",
  },
];

const REVIEW_JOB = "reviews";

/**
 * setup, diff and cleanup jobs say nothing about soundness and are the most
 * often retried, so they are excluded from the gate counts
 */
const MACHINERY_JOBS: ReadonlySet<string> = new Set([
  "setup",
  "detect-changes",
  "cleanup",
]);

export interface ConfigFile {
  path: string;
  jsonPath: string[];
}

/**
 * CI re-hashes these files at the same commit; keep in step with the check_hash
 * calls in ci.yml (a fitness rule enforces it), since a dropped file only makes
 * CI warn
 */
export const CONFIG_FILES: ReadonlyArray<ConfigFile> = [
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
  {
    path: "verification/review-prompts/comment-review.md",
    jsonPath: ["prompts", "comment-review"],
  },
  ...WORKFLOWS.map((w) => ({
    path: w.path,
    jsonPath: ["workflows", w.name],
  })),
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
  // the generator imports one and runs the other; together they decide
  // affectedCommands, so both are pinned
  {
    path: "scripts/affected_commands.ts",
    jsonPath: ["scripts", "affected-commands"],
  },
  {
    path: "scripts/command_index.ts",
    jsonPath: ["scripts", "command-index"],
  },
  // trigger evals decide whether skills still route correctly, so the runner,
  // provider, case generators, and the installer and lockfile fixing the
  // promptfoo tree are pinned too
  {
    path: "scripts/eval_skill_triggers_promptfoo.ts",
    jsonPath: ["scripts", "eval-skill-triggers-runner"],
  },
  {
    path: "evals/promptfoo/claude_cli_provider.mjs",
    jsonPath: ["scripts", "eval-claude-cli-provider"],
  },
  {
    path: "evals/promptfoo/codex_cli_provider.mjs",
    jsonPath: ["scripts", "eval-codex-cli-provider"],
  },
  {
    path: "evals/promptfoo/provider_route.ts",
    jsonPath: ["scripts", "eval-provider-route"],
  },
  {
    path: "evals/promptfoo/generate_config.ts",
    jsonPath: ["scripts", "eval-generate-config"],
  },
  {
    path: "evals/promptfoo/generate_routing_config.ts",
    jsonPath: ["scripts", "eval-generate-routing-config"],
  },
  {
    path: "evals/promptfoo/generate_sufficiency_config.ts",
    jsonPath: ["scripts", "eval-generate-sufficiency-config"],
  },
  {
    path: "scripts/promptfoo_install.ts",
    jsonPath: ["scripts", "eval-promptfoo-install"],
  },
  {
    path: "evals/promptfoo/package-lock.json",
    jsonPath: ["scripts", "eval-promptfoo-lockfile"],
  },
];


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
  steps: StepRecord[];
}

export interface RunRecord {
  id: string;
  workflowName: string;
  status?: string;
  startedAt?: string;
  duration?: number;
  inputs?: Record<string, unknown>;
  path?: string;
  jobs: JobRecord[];
}


interface WorkflowStepDef {
  name?: string;
  task?: { modelName?: string; inputs?: { run?: string } };
}

interface WorkflowJobDef {
  name?: string;
  steps?: WorkflowStepDef[];
}

export interface WorkflowDef {
  inputs?: InputsSchema;
  jobs?: WorkflowJobDef[];
}


/**
 * drops dynamic-linker variables: Deno refuses to spawn under a scoped
 * --allow-run while one is set. the match is broad and case-insensitive to
 * cover LD_ and DYLD spellings
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (/^LD_|DYLD/i.test(key)) continue;
    env[key] = value;
  }
  // captured values land in the attestation verbatim, so children must not
  // colour output; the swamp binary on PATH may not honour NO_COLOR itself
  env.NO_COLOR = "1";
  return env;
}

async function capture(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const { code, stdout } = await new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "piped",
      env: childEnv(),
      clearEnv: true,
    }).output();
    return code === 0 ? new TextDecoder().decode(stdout) : null;
  } catch {
    return null;
  }
}

/**
 * reads the file at the verified commit, not the working tree; they differ when
 * a prompt or workflow is edited after verification starts
 */
async function showAtCommit(
  commit: string,
  path: string,
): Promise<Uint8Array | null> {
  try {
    const { code, stdout } = await new Deno.Command("git", {
      args: ["show", `${commit}:${path}`],
      stdout: "piped",
      stderr: "piped",
      env: childEnv(),
      clearEnv: true,
    }).output();
    return code === 0 ? stdout : null;
  } catch {
    return null;
  }
}

/**
 * canonicalises revisions so an abbreviation and its full SHA compare equal;
 * kept out of AttestationSchema, which is shared with CI. null when git cannot
 * resolve a commit
 */
async function resolveRevision(revision: string): Promise<string | null> {
  const resolved = await capture("git", [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  return resolved?.trim() || null;
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

export function describeSkip(reason: SkipReason | undefined): string {
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
 * the run record does not carry the model name, so it is rebuilt from the
 * provenance-checked definition, tying it to the file whose hash is pinned
 */
export function modelNames(
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

export function reviewModels(workflow: WorkflowDef): Map<string, string> {
  const models = new Map<string, string>();
  const job = (workflow.jobs ?? []).find((j) => j.name === REVIEW_JOB);
  for (const step of job?.steps ?? []) {
    const match = step.task?.inputs?.run?.match(/--model\s+(\S+)/);
    if (step.name && match) models.set(step.name, match[1]);
  }
  return models;
}


export interface RunSource {
  key: string;
  name: string;
  run: RunRecord;
  definition: WorkflowDef;
}

export interface AttestationEnvironment {
  commit: string;
  branch: string;
  configIntegrity: Record<string, unknown>;
  denoVersion: string;
  swampVersion?: string;
  os: string;
  arch: string;
  now: Date;
  affectedCommands?: AffectedCommands;
}

/** pure: no parameter lets a caller assert something the runs did not record */
export function buildAttestation(
  sources: readonly RunSource[],
  env: AttestationEnvironment,
): Record<string, unknown> {
  const steps: AttestationStepData[] = [];

  for (const source of sources) {
    const models = modelNames(source.definition, source.run.id);
    for (const job of source.run.jobs) {
      if (MACHINERY_JOBS.has(job.name)) continue;
      for (const step of job.steps) {
        steps.push({
          job: job.name,
          step: step.name,
          model: models.get(`${job.name}:${step.name}`),
          status: step.status,
          durationMs: step.duration,
          // a review step's status is the gate decision, since
          // check_review_verdict.ts decides its exit code; the reviewer's prose
          // is only its input
          verdict: job.name === REVIEW_JOB && step.status === "succeeded"
            ? "pass"
            : undefined,
          skipKind: step.status === "skipped"
            ? step.skipReason?.kind
            : undefined,
          skipExpression: step.status === "skipped"
            ? step.skipReason?.expression
            : undefined,
          reason: step.status === "skipped"
            ? describeSkip(step.skipReason)
            : undefined,
          errorMessage: step.status === "failed" ? step.error : undefined,
        });
      }
    }
  }

  const succeeded = steps.filter((s) => s.status === "succeeded").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  // anything neither succeeded nor skipped counts as failed: an unknown or
  // still-running step is one nobody can vouch for
  const failed = steps.length - succeeded - skipped;

  const skippedByKind: Record<string, number> = {};
  for (const step of steps) {
    if (step.status !== "skipped") continue;
    const kind = step.skipKind ?? "unrecorded";
    skippedByKind[kind] = (skippedByKind[kind] ?? 0) + 1;
  }

  const reviewsSource = sources.find((s) => s.name === "verify-reviews");
  const reviewConfig: Record<string, unknown> = {};
  if (reviewsSource) {
    const reviewers = reviewModels(reviewsSource.definition);
    const reviewsJob = reviewsSource.run.jobs.find((j) =>
      j.name === REVIEW_JOB
    );
    for (const step of reviewsJob?.steps ?? []) {
      reviewConfig[step.name] = {
        model: reviewers.get(step.name),
        ran: step.status === "succeeded",
        // derived from the persisted skip reason, which tells a path guard
        // exclusion from a job that never started
        reason: step.status === "skipped"
          ? describeSkip(step.skipReason)
          : undefined,
      };
    }
  }

  const runs: Record<string, string> = {};
  for (const source of sources) runs[source.key] = source.run.id;

  // runs may overlap, so duration spans the earliest start to the latest end.
  // completedAt comes from the runs, not now: this runs afterwards and CI
  // measures freshness from it
  const startTimes = sources
    .map((s) => s.run.startedAt)
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t));

  const endTimes = sources
    .map((s) => {
      if (!s.run.startedAt || s.run.duration === undefined) return Number.NaN;
      return new Date(s.run.startedAt).getTime() + s.run.duration;
    })
    .filter((t) => !Number.isNaN(t));

  const startedAt = startTimes.length > 0
    ? new Date(Math.min(...startTimes))
    : undefined;
  // a run with no recorded duration falls back to the clock rather than claim a
  // completion the records do not support
  const completedAt = endTimes.length > 0
    ? new Date(Math.max(...endTimes))
    : env.now;

  return {
    version: "1",
    type: "verification-attestation",
    // stated, not proven: the document was projected by this script, which does
    // not mean nothing else could have produced it
    generatedBy: "script",

    subject: { commit: env.commit, branch: env.branch },

    environment: {
      denoVersion: env.denoVersion,
      swampVersion: env.swampVersion,
      os: env.os,
      arch: env.arch,
    },

    configIntegrity: env.configIntegrity,
    reviewConfig,
    steps,

    gate: {
      // every verification workflow must contribute a run, else naming one run
      // gives zero failures and a green gate for mostly missing verification
      allPassed: failed === 0 && sources.length === WORKFLOWS.length,
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

    runs,

    affectedCommands: env.affectedCommands,
  };
}


/**
 * matched by the name on each record, since a caller labelling a build run as
 * reviews would make the attestation claim reviews passed
 */
export function matchRunsToWorkflows(
  runs: readonly RunRecord[],
): { sources: Array<{ key: string; name: string; run: RunRecord }> } | {
  error: string;
} {
  const byName = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const existing = byName.get(run.workflowName) ?? [];
    existing.push(run);
    byName.set(run.workflowName, existing);
  }

  const sources: Array<{ key: string; name: string; run: RunRecord }> = [];
  const missing: string[] = [];
  for (const workflow of WORKFLOWS) {
    const matches = byName.get(workflow.name) ?? [];
    if (matches.length === 0) {
      missing.push(workflow.name);
      continue;
    }
    if (matches.length > 1) {
      return {
        error: `more than one ${workflow.name} run was given (${
          matches.map((r) => r.id).join(", ")
        }); name exactly one run per workflow`,
      };
    }
    sources.push({ key: workflow.key, name: workflow.name, run: matches[0] });
  }

  if (missing.length > 0) {
    return {
      error: `no run was given for ${missing.join(", ")}; the attestation ` +
        "covers all three verification workflows",
    };
  }

  const unknown = [...byName.keys()].filter((name) =>
    !WORKFLOWS.some((w) => w.name === name)
  );
  if (unknown.length > 0) {
    return {
      error: `not a verification workflow: ${unknown.join(", ")}`,
    };
  }

  return { sources };
}

/**
 * a stale run record yields a well-formed document describing a different tree,
 * so each run must have examined the attested commit
 */
export function checkCommitBinding(
  sources: ReadonlyArray<{ name: string; run: RunRecord }>,
  commit: string,
): string[] {
  const errors: string[] = [];
  for (const source of sources) {
    const ran = source.run.inputs?.["commit"];
    if (typeof ran !== "string") {
      errors.push(
        `${source.name} run ${source.run.id} records no commit input, so it ` +
          "cannot be shown to have examined this commit",
      );
      continue;
    }
    if (ran !== commit) {
      // print both identifiers in full so a SHA and its abbreviation are not
      // rendered as the same text
      errors.push(
        `${source.name} run ${source.run.id} was launched against ${ran}, ` +
          `but this attestation names ${commit}`,
      );
    }
  }
  return errors;
}

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;

/**
 * swamp's own bookkeeping at the snapshot root; it describes how the snapshot
 * was written, not what the run executed
 */
const RUN_METADATA_KEYS: ReadonlySet<string> = new Set([
  "sensitiveFormat",
  "writtenReferences",
]);

/**
 * located from the run record's own path, so no guess is needed about which
 * repository the run was launched against
 */
export function evaluatedWorkflowPath(run: RunRecord): string | null {
  if (!run.path) return null;
  const swampDir = dirname(dirname(dirname(run.path)));
  return join(
    swampDir,
    "workflows-evaluated",
    "runs",
    run.id,
    "evaluated-workflow.yaml",
  );
}

/**
 * compares the committed definition, as a template, with the one the run
 * executed: expressions match anything, else exact; fields only the evaluated
 * one has pass when empty, zero or false; snapshot metadata is ignored
 */
export function checkWorkflowProvenance(
  committed: unknown,
  evaluated: unknown,
  at = "",
): string[] {
  if (typeof committed === "string" && EXPRESSION.test(committed)) {
    const literals = committed.split(new RegExp(EXPRESSION, "g"));
    if (literals.every((l) => l.trim() === "")) return [];
    const pattern = new RegExp(
      `^${
        literals.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(
          "[\\s\\S]*",
        )
      }$`,
    );
    return typeof evaluated === "string" && pattern.test(evaluated)
      ? []
      : [`${at || "(root)"} differs from the committed definition`];
  }

  if (Array.isArray(committed)) {
    if (!Array.isArray(evaluated) || evaluated.length !== committed.length) {
      return [
        `${at || "(root)"} has ${
          Array.isArray(evaluated) ? evaluated.length : "no"
        } entries where the committed definition has ${committed.length}`,
      ];
    }
    return committed.flatMap((value, i) =>
      checkWorkflowProvenance(value, evaluated[i], `${at}[${i}]`)
    );
  }

  if (committed !== null && typeof committed === "object") {
    if (
      evaluated === null || typeof evaluated !== "object" ||
      Array.isArray(evaluated)
    ) {
      return [`${at || "(root)"} is not a mapping in the evaluated workflow`];
    }
    const c = committed as Record<string, unknown>;
    const e = evaluated as Record<string, unknown>;
    const errors: string[] = [];
    for (const key of Object.keys(c)) {
      const path = at ? `${at}.${key}` : key;
      if (!(key in e)) {
        errors.push(`${path} is missing from the evaluated workflow`);
      } else errors.push(...checkWorkflowProvenance(c[key], e[key], path));
    }
    for (const key of Object.keys(e)) {
      if (key in c || isEmptyDefault(e[key])) continue;
      if (at === "" && RUN_METADATA_KEYS.has(key)) continue;
      errors.push(
        `${
          at ? `${at}.${key}` : key
        } is in the evaluated workflow but not the committed definition`,
      );
    }
    return errors;
  }

  return committed === evaluated
    ? []
    : [`${at || "(root)"} differs from the committed definition`];
}

/** Bind shell inputs exactly, preserving run.id as the saved snapshot does. */
export function checkVerificationProvenance(
  committed: WorkflowDef,
  evaluated: unknown,
  run: RunRecord,
): string[] {
  const validation = new InputValidationService();
  const inputs = committed.inputs
    ? validation.applyDefaults(run.inputs ?? {}, committed.inputs)
    : run.inputs ?? {};
  if (committed.inputs) {
    const result = validation.validate(inputs, committed.inputs);
    if (!result.valid) {
      return result.errors.map((error) =>
        `recorded input ${error.path}: ${error.message}`
      );
    }
  }
  const expected = structuredClone(committed);
  const evaluator = new CelEvaluator();
  for (const job of expected.jobs ?? []) {
    for (const step of job.steps ?? []) {
      const shell = step.task?.inputs?.run;
      if (shell === undefined) continue;
      try {
        const values = new Map(
          extractExpressions(shell).map((expression) => [
            expression.raw,
            expression.celExpression === "run.id"
              ? expression.raw
              : evaluator.evaluate(expression.celExpression, { inputs }),
          ]),
        );
        step.task!.inputs!.run = replaceExpressions(shell, values) as string;
      } catch (error) {
        return [`cannot evaluate ${job.name}/${step.name} shell: ${error}`];
      }
    }
  }
  const errors = checkWorkflowProvenance(expected, evaluated);
  if (errors.length > 0) return errors;
  // Structure was checked above. Shells must match exactly, including the
  // deferred run.id text: it must not become a provenance wildcard.
  const snapshot = evaluated as WorkflowDef;
  for (const [jobIndex, job] of (expected.jobs ?? []).entries()) {
    for (const [stepIndex, step] of (job.steps ?? []).entries()) {
      const shell = step.task?.inputs?.run;
      if (shell === undefined) continue;
      const actual = snapshot.jobs?.[jobIndex].steps?.[stepIndex].task?.inputs
        ?.run;
      if (shell !== actual) {
        errors.push(
          `jobs[${jobIndex}].steps[${stepIndex}].task.inputs.run differs from the committed definition`,
        );
      }
    }
  }
  return errors;
}

function isEmptyDefault(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return value === false || value === 0 || value === null ||
    value === undefined || value === "";
}


const SUBPROCESS_TIMEOUT_MS = 120 * 1000;

/**
 * untracked files are not checked: one nothing tracked imports is outside the
 * module graph, and one a tracked file imports shows up as that edit
 */
export function checkCheckout(
  head: string | null,
  status: string | null,
  commit: string,
): string[] {
  if (!head || status === null) {
    return ["could not read the state of this checkout from git"];
  }
  const errors: string[] = [];
  if (head !== commit) {
    errors.push(
      `this checkout is at ${head}, but this attestation names ${commit}`,
    );
  }
  const modified = status.split("\n").filter((line) => line.trim() !== "");
  if (modified.length > 0) {
    errors.push(
      `this checkout has ${modified.length} modified tracked file(s), so it ` +
        `is not the tree at ${commit}:\n` +
        modified.slice(0, 10).map((line) => `  ${line}`).join("\n"),
    );
  }
  return errors;
}

export function parseCommandIndex(stdout: string): CommandIndex | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      return null;
    }
    const entries = Object.entries(parsed);
    if (entries.length === 0) return null;
    return entries.every(([, file]) =>
        typeof file === "string" && file.startsWith(COMMAND_DIR)
      )
      ? parsed as CommandIndex
      : null;
  } catch {
    return null;
  }
}

/**
 * rename detection is off so a moved file is a deletion plus an addition and
 * the old path is classified; the caller's git config must not change what an
 * attestation says
 */
export function diffNamesArgs(
  filter: string,
  diffBase: string,
  commit: string,
): string[] {
  return [
    "diff",
    "--name-only",
    "--no-renames",
    `--diff-filter=${filter}`,
    "-z",
    diffBase,
    commit,
  ];
}

async function runChild(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { code, stdout, stderr } = await new Deno.Command(command, {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: childEnv(),
      clearEnv: true,
      signal: AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS),
    }).output();
    const decoder = new TextDecoder();
    return {
      ok: code === 0,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * diffs against the merge base with origin/main, the same three-dot diff the
 * review guards use; deleted files are listed apart as they are in no graph
 */
async function gatherAffectedCommands(
  commit: string,
  repoRoot: string,
): Promise<{ affectedCommands: AffectedCommands } | { error: string }> {
  const diffBase = (await capture("git", ["merge-base", "origin/main", commit]))
    ?.trim();
  if (!diffBase) {
    return {
      error: `git finds no merge base between origin/main and ${commit}; ` +
        "fetch origin/main so the change can be diffed against it",
    };
  }
  const diffNames = async (filter: string) => {
    const diff = await capture(
      "git",
      diffNamesArgs(filter, diffBase, commit),
    );
    return diff === null
      ? null
      : diff.split("\0").filter((file) => file !== "");
  };
  const changedFiles = await diffNames("d");
  const deletedFiles = await diffNames("D");
  if (changedFiles === null || deletedFiles === null) {
    return { error: `could not diff ${commit} against ${diffBase}` };
  }

  const info = await runChild(
    "deno",
    ["info", "--json", ENTRY_POINT],
    repoRoot,
  );
  if (!info.ok) {
    return {
      error: `deno info ${ENTRY_POINT} failed: ${info.stderr.trim()}`,
    };
  }
  let graph;
  try {
    graph = buildImportGraph(JSON.parse(info.stdout) as DenoInfo, repoRoot);
  } catch {
    return { error: `deno info ${ENTRY_POINT} did not print a module graph` };
  }

  // Only command files the CLI already loads are handed over; see
  // command_index.ts for why the rest of the directory must not be imported.
  const commandFiles = [...graph.keys()]
    .filter((file) =>
      file.startsWith(COMMAND_DIR) &&
      !file.slice(COMMAND_DIR.length).includes("/")
    )
    .sort();
  const indexed = await runChild("deno", [
    "run",
    "--no-prompt",
    "--unstable-bundle",
    "--allow-read",
    "--allow-env",
    "--allow-sys",
    "--allow-ffi",
    "scripts/command_index.ts",
    ...commandFiles,
  ], repoRoot);
  const index = indexed.ok ? parseCommandIndex(indexed.stdout) : null;
  if (!index) {
    return {
      error: "could not map commands to their files: " +
        (indexed.stderr.trim() || "the command index was not valid JSON"),
    };
  }

  return {
    affectedCommands: computeAffectedCommands({
      graph,
      index,
      changedFiles,
      deletedFiles,
      diffBase,
    }),
  };
}

async function fetchRun(id: string): Promise<RunRecord | null> {
  const record = await capture("swamp", [
    "workflow",
    "history",
    "get",
    id,
    "--json",
  ]);
  if (!record) return null;
  try {
    return JSON.parse(record) as RunRecord;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ["run", "commit", "branch"],
    collect: ["run"],
  });

  const runIds = (args.run ?? []) as string[];
  const requestedCommit = args.commit;
  const branch = args.branch;
  if (runIds.length === 0 || !requestedCommit || !branch) {
    console.error(
      "usage: build_attestation.ts --run <id> --run <id> --run <id> " +
        "--commit <sha> --branch <name>",
    );
    return 2;
  }

  // resolved once and used everywhere: CI compares the commit in the document
  // to the PR head as a string, so it must not be an abbreviation
  const commit = await resolveRevision(requestedCommit);
  if (!commit) {
    console.error(
      `git cannot resolve ${requestedCommit} to a commit in this repository`,
    );
    return 1;
  }

  // checked before anything else is read: the affected-commands list comes from
  // files on disk, so a checkout that moved on would describe another tree
  const repoRoot = (await capture("git", ["rev-parse", "--show-toplevel"]))
    ?.trim();
  const checkoutErrors = checkCheckout(
    (await capture("git", ["rev-parse", "HEAD"]))?.trim() ?? null,
    await capture("git", ["status", "--porcelain", "--untracked-files=no"]),
    commit,
  );
  if (!repoRoot || checkoutErrors.length > 0) {
    for (const error of checkoutErrors) console.error(error);
    console.error(
      "run this from a clean checkout of the verified commit; the list of " +
        "affected commands is read from the files on disk",
    );
    return 1;
  }

  const runs: RunRecord[] = [];
  for (const id of runIds) {
    const run = await fetchRun(id);
    if (!run) {
      console.error(
        `could not read run ${id}; check the id with ` +
          "`SWAMP_WORKFLOWS_DIR=verification swamp workflow history`",
      );
      return 1;
    }
    runs.push(run);
  }

  const matched = matchRunsToWorkflows(runs);
  if ("error" in matched) {
    console.error(matched.error);
    return 1;
  }

  // each run's recorded commit is resolved the same way, so the check asks
  // whether the run examined this commit, not how its launcher spelled it
  const resolvedSources = [];
  for (const source of matched.sources) {
    const recorded = source.run.inputs?.["commit"];
    const resolved = typeof recorded === "string"
      ? await resolveRevision(recorded)
      : null;
    resolvedSources.push({
      ...source,
      run: resolved
        ? { ...source.run, inputs: { ...source.run.inputs, commit: resolved } }
        : source.run,
    });
  }

  const bindingErrors = checkCommitBinding(resolvedSources, commit);
  if (bindingErrors.length > 0) {
    for (const error of bindingErrors) console.error(error);
    console.error(
      "re-run verification against this commit rather than attesting to a " +
        "run that examined a different tree",
    );
    return 1;
  }

  // definitions are read at the verified commit, as their hashes are: the
  // working tree file may have moved since the run
  const sources: RunSource[] = [];
  for (const source of matched.sources) {
    const workflow = WORKFLOWS.find((w) => w.name === source.name)!;
    const raw = await showAtCommit(commit, workflow.path);
    if (!raw) {
      console.error(`could not read ${workflow.path} at ${commit.slice(0, 8)}`);
      return 1;
    }
    const definition = parseYaml(new TextDecoder().decode(raw));

    const evaluatedPath = evaluatedWorkflowPath(source.run);
    let evaluated: unknown;
    try {
      evaluated = evaluatedPath
        ? parseYaml(await Deno.readTextFile(evaluatedPath))
        : undefined;
    } catch {
      evaluated = undefined;
    }
    if (evaluated === undefined) {
      console.error(
        `${source.name} run ${source.run.id} has no evaluated workflow` +
          (evaluatedPath ? ` at ${evaluatedPath}` : "") +
          ", so it cannot be shown to have executed " +
          `${workflow.path} as committed`,
      );
      return 1;
    }
    const provenanceErrors = checkVerificationProvenance(
      definition as WorkflowDef,
      evaluated,
      source.run,
    );
    if (provenanceErrors.length > 0) {
      console.error(
        `${source.name} run ${source.run.id} did not execute ${workflow.path} ` +
          `as it stands at ${commit}:`,
      );
      for (const error of provenanceErrors) console.error(`  ${error}`);
      console.error(
        "re-run verification with SWAMP_WORKFLOWS_DIR pointing at this " +
          "commit's verification/ directory; a relative path resolves " +
          "against --repo-dir, not the current directory",
      );
      return 1;
    }

    sources.push({ ...source, definition: evaluated as WorkflowDef });
  }

  const configIntegrity: Record<string, unknown> = {};
  for (const file of CONFIG_FILES) {
    const content = await showAtCommit(commit, file.path);
    if (!content) {
      console.error(
        `::warning::${file.path} not found at ${
          commit.slice(0, 8)
        }; its hash will be absent from the attestation`,
      );
      continue;
    }
    setIn(configIntegrity, file.jsonPath, await computeChecksum(content));
  }

  const affected = await gatherAffectedCommands(commit, repoRoot);
  if ("error" in affected) {
    console.error(affected.error);
    return 1;
  }

  // -V gives the bare version; --version prepends the program name, which the
  // CI summary supplies itself
  const swampVersion = (await capture("swamp", ["-V"]))?.trim();

  const attestation = buildAttestation(sources, {
    commit,
    branch,
    configIntegrity,
    denoVersion: Deno.version.deno,
    swampVersion,
    os: Deno.build.os,
    arch: Deno.build.arch,
    now: new Date(),
    affectedCommands: affected.affectedCommands,
  });

  // post_attestation validates again, which is not redundant: it catches a
  // document this script did not write
  const validated = AttestationSchema.safeParse(attestation);
  if (!validated.success) {
    console.error("generated attestation does not match AttestationSchema:");
    for (const issue of validated.error.issues) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return 1;
  }

  console.log(JSON.stringify(attestation, null, 2));
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
