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

// Architectural fitness test: the pre-PR review harness may not lie about what
// it reviewed, or about whether it reviewed anything at all.
//
// Two defects behind swamp-club#2265 motivate the rules below, and both landed
// in four places at once because the review steps were four copies of the same
// shell:
//
//   1. Every review prompt opened by telling the reviewer to run a diff command
//      to find the changed files. No review step grants Bash, so the very first
//      instruction was impossible — and it contradicted the diff file the step
//      hands over at runtime. Reviews were observed discussing commits that
//      were not in the diff at all.
//   2. A review that emitted no VERDICT marker was scored by inferring one, and
//      the inference defaulted to pass. A review reporting two blocking
//      findings in prose was recorded as an approval, and the workflow reported
//      success.
//
// Nothing else guards these: CI does not re-run the agent reviews, it only
// checksums the prompts and workflows, so a wrong review that records itself as
// a pass is the whole signal.
//
// The count assertions are load-bearing. A renamed file or a pattern that
// quietly stops matching would otherwise turn every check below into a vacuous
// pass — exactly the failure mode this test exists to prevent.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { repoRelative, ROOT } from "./arch_fitness_helpers.ts";

const PROMPTS_DIR = join(ROOT, "verification", "review-prompts");
// The agent reviews are the `reviews` job of the consolidated submit-change
// workflow. They used to be a workflow of their own; the rules below are about
// the review steps, so they follow the steps rather than the file.
const REVIEWS_WORKFLOW = join(
  ROOT,
  "verification",
  "workflow-submit-change.yaml",
);
const VERDICT_SCRIPT = "scripts/check_review_verdict.ts";

/**
 * The review prompts, pinned. A new prompt has to be added here consciously,
 * which is the moment to check it against the rules below.
 */
const EXPECTED_PROMPTS = [
  "adversarial-review.md",
  "ci-security-review.md",
  "code-review.md",
  "ux-review.md",
];

/**
 * The review steps, pinned, each with the label it passes to the verdict
 * script. A fifth review added without a line here fails the step-count
 * assertion rather than slipping through unchecked — which is how both of this
 * issue's defects reached four copies in the first place.
 */
const EXPECTED_REVIEW_STEPS: Record<string, string> = {
  "code-review": "Code review",
  "adversarial-review": "Adversarial review",
  "ux-review": "UX review",
  "ci-security-review": "CI security review",
};

/**
 * Instructions telling the reviewer to run something. The reviewer is invoked
 * with `--allowedTools "Read,Glob,Grep"`, so it has no shell: any imperative to
 * run, execute or invoke a command is an instruction it cannot follow.
 *
 * Deliberately keyed on the imperative and not on any command name. The prompts
 * must still talk about the diff they are handed — a rule matching "diff" would
 * fail the very text that fixes this.
 */
const RUN_INSTRUCTION_PATTERNS = [
  /\brun\s+`/i,
  /\b(execute|invoke)\s+`/i,
  /\brun\s+the\s+(command|following)\b/i,
];

interface WorkflowStep {
  readonly name?: string;
  readonly task?: { readonly inputs?: { readonly run?: string } };
}

interface WorkflowJob {
  readonly name?: string;
  readonly steps?: readonly WorkflowStep[];
}

interface ReviewsWorkflow {
  readonly jobs?: readonly WorkflowJob[];
}

async function readReviewsWorkflow(): Promise<ReviewsWorkflow> {
  const source = await Deno.readTextFile(REVIEWS_WORKFLOW);
  return parseYaml(source) as ReviewsWorkflow;
}

function reviewSteps(workflow: ReviewsWorkflow): readonly WorkflowStep[] {
  const job = (workflow.jobs ?? []).find((j) => j.name === "reviews");
  if (!job) {
    throw new Error(
      `No "reviews" job in ${
        repoRelative(REVIEWS_WORKFLOW)
      } — the job was renamed, ` +
        "which would make every rule in this file a vacuous pass.",
    );
  }
  return job.steps ?? [];
}

Deno.test("review prompts: the expected set is present", async () => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".md")) found.push(entry.name);
  }
  assertEquals(found.sort(), EXPECTED_PROMPTS);
});

Deno.test("review prompts: none instructs the reviewer to run a command", async () => {
  const violations: string[] = [];
  for (const name of EXPECTED_PROMPTS) {
    const source = await Deno.readTextFile(join(PROMPTS_DIR, name));
    for (const pattern of RUN_INSTRUCTION_PATTERNS) {
      const match = source.match(pattern);
      if (match) violations.push(`${name}: ${JSON.stringify(match[0])}`);
    }
  }
  assertEquals(
    violations,
    [],
    "Review prompts must not instruct the reviewer to run a command — the " +
      'review steps grant only "Read,Glob,Grep", so such an instruction is ' +
      "impossible to follow and contradicts the diff file the step provides. " +
      `Offending prompts: ${violations.join("; ")}`,
  );
});

Deno.test("review prompts: each scopes the review to the provided diff", async () => {
  for (const name of EXPECTED_PROMPTS) {
    const source = await Deno.readTextFile(join(PROMPTS_DIR, name));
    assertStringIncludes(
      source.toLowerCase(),
      "the diff under review is provided as a file",
      `${name} must point the reviewer at the diff it is handed`,
    );
  }
});

Deno.test("submit-change reviews: the expected review steps are present", async () => {
  const steps = reviewSteps(await readReviewsWorkflow());
  assertEquals(
    steps.map((s) => s.name).sort(),
    Object.keys(EXPECTED_REVIEW_STEPS).sort(),
  );
});

Deno.test("submit-change reviews: every review step delegates its verdict to the shared script", async () => {
  const steps = reviewSteps(await readReviewsWorkflow());
  for (const step of steps) {
    const name = step.name ?? "<unnamed>";
    const run = step.task?.inputs?.run;
    assertEquals(
      typeof run,
      "string",
      `review step ${name} has no shell to check`,
    );
    const label = EXPECTED_REVIEW_STEPS[name];
    assertStringIncludes(
      run!,
      VERDICT_SCRIPT,
      `review step ${name} must delegate its verdict to ${VERDICT_SCRIPT} ` +
        "rather than carrying its own copy of the rule",
    );
    assertStringIncludes(
      run!,
      `"${label}"`,
      `review step ${name} must pass its review label to ${VERDICT_SCRIPT}`,
    );
  }
});

Deno.test("submit-change reviews: no step infers a verdict when the marker is absent", async () => {
  const source = await Deno.readTextFile(REVIEWS_WORKFLOW);
  // A reviewer that does not answer in the required format is precisely when a
  // human should look, so the absence of a marker must fail the step. Neither
  // direction may be inferred — an inferred fail is a guess too, and the same
  // branch that produces it is what produced the inferred pass.
  const forbidden = [
    /inferred\s+pass/i,
    /inferred\s+fail/i,
    /VERDICT="pass"/,
    /VERDICT="fail"/,
  ];
  const violations = forbidden
    .map((pattern) => source.match(pattern)?.[0])
    .filter((match): match is string => match !== undefined);
  assertEquals(
    violations,
    [],
    "The reviews job must not infer a verdict from output that carries no " +
      `VERDICT marker. Offending text: ${violations.join("; ")}`,
  );
});

// ── Group guards ───────────────────────────────────────────────────────────
//
// submit-change replaced three workflows with three guarded groups in one
// file, so "this group did not run" is now a property of every step's guard
// rather than of the run that was never launched. A job whose steps all skip
// still reports `succeeded`, so a step that loses its group flag does not skip
// with its group — it runs against a worktree the group's setup step never
// created, and fails for a reason that has nothing to do with the change.

/** Job-name prefix → the boolean input that selects that group. */
const GROUP_FLAGS: Record<string, string> = {
  "build-": "runBuild",
  "reviews": "runReviews",
  "skills": "runSkills",
};

/**
 * Jobs that deliberately run whatever the group flags say: the run's own
 * machinery. Attesting has to happen on a subset re-run too, or deselecting a
 * group would quietly stop producing an attestation.
 */
const UNGUARDED_JOBS = [
  "attest",
  "record-verification",
  "publish-attestation",
  "open-pr",
  "cleanup",
];

interface GuardedStep extends WorkflowStep {
  readonly guard?: string;
}

function groupFlagFor(jobName: string): string | undefined {
  for (const [prefix, flag] of Object.entries(GROUP_FLAGS)) {
    if (jobName.startsWith(prefix)) return flag;
  }
  return undefined;
}

Deno.test("submit-change: every step in a group carries its group's flag", async () => {
  const workflow = await readReviewsWorkflow();
  const jobs = workflow.jobs ?? [];

  // Load-bearing: a renamed job prefix would leave this test checking nothing.
  const grouped = jobs.filter((j) => groupFlagFor(j.name ?? "") !== undefined);
  assertEquals(
    jobs.length - grouped.length,
    UNGUARDED_JOBS.length,
    `Every job must belong to a guarded group or be listed in ` +
      `UNGUARDED_JOBS. Ungrouped: ${
        jobs
          .filter((j) => groupFlagFor(j.name ?? "") === undefined)
          .map((j) => j.name)
          .join(", ")
      }`,
  );

  const violations: string[] = [];
  for (const job of grouped) {
    const flag = groupFlagFor(job.name ?? "")!;
    for (const step of (job.steps ?? []) as readonly GuardedStep[]) {
      if (!step.guard?.includes(`!inputs.${flag}`)) {
        violations.push(`${job.name}/${step.name}: expected !inputs.${flag}`);
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Every step in a verification group must be guarded by that group's " +
      "boolean input, or deselecting the group leaves it running against a " +
      `worktree that was never created. Offenders: ${violations.join("; ")}`,
  );
});

Deno.test("submit-change: a group's setup step is guarded by the flag alone", async () => {
  const workflow = await readReviewsWorkflow();
  // The setup guard is what makes a deselected group distinguishable from a
  // path guard correctly excluding one review: setup skipped means the whole
  // group was deselected, setup succeeded means the path guard decided.
  const setups = (workflow.jobs ?? []).filter((j) =>
    (j.name ?? "").endsWith("-setup")
  );
  assertEquals(setups.length, 3, "expected one setup job per group");

  for (const job of setups) {
    const flag = groupFlagFor(job.name ?? "")!;
    const steps = (job.steps ?? []) as readonly GuardedStep[];
    assertEquals(steps.length, 1, `${job.name} must have one setup step`);
    assertEquals(
      steps[0].guard,
      `\${{ !inputs.${flag} }}`,
      `${job.name}'s guard must be the group flag alone — a compound guard ` +
        "makes a deselected group indistinguishable from a path-guard skip",
    );
  }
});

// ── The attestation step must survive a deselected group ───────────────────

interface DependencyDef {
  readonly job?: string;
  readonly condition?: { readonly type?: string };
}

interface DependentJob extends WorkflowJob {
  readonly dependsOn?: readonly DependencyDef[];
}

Deno.test("submit-change: attest does not depend on a group succeeding", async () => {
  // A deselected group's jobs report `skipped`, and a skipped job does not
  // satisfy a `succeeded` dependency. A `succeeded` condition here would stop
  // the run attesting at all the moment anyone re-ran a subset — silently,
  // because nothing downstream would run to complain.
  const workflow = await readReviewsWorkflow();
  const attest = ((workflow.jobs ?? []) as readonly DependentJob[])
    .find((j) => j.name === "attest");

  assertEquals(
    attest !== undefined,
    true,
    "no `attest` job — the attestation is no longer generated by the run",
  );

  const deps = attest!.dependsOn ?? [];
  assertEquals(
    deps.length > 0,
    true,
    "attest must depend on the verification groups",
  );

  const wrong = deps
    .filter((d) => d.condition?.type !== "always")
    .map((d) => `${d.job}: ${d.condition?.type}`);

  assertEquals(
    wrong,
    [],
    "every attest dependency must use `always` (or an or of succeeded and " +
      "skipped) so a deselected group still produces an attestation. " +
      `Offenders: ${wrong.join("; ")}`,
  );
});

// ── The PR cannot be opened without the attestation ────────────────────────

interface EnvStep extends WorkflowStep {
  readonly task?: {
    readonly inputs?: {
      readonly run?: string;
      readonly env?: Record<string, string>;
      readonly url?: string;
      readonly attestation?: string;
    };
  };
}

Deno.test("submit-change: creating the PR takes the attestation as an input", async () => {
  // `gh pr create` used to live in a skill, so no check on link_pr could stop
  // an unattested PR — by the time link_pr ran, the PR existed. The step that
  // opens the PR must therefore depend on data that exists only once an
  // attestation was accepted, making an unattested PR unrepresentable rather
  // than rejected.
  const workflow = await readReviewsWorkflow();
  const openPr = (workflow.jobs ?? []).find((j) => j.name === "open-pr");

  assertEquals(
    openPr !== undefined,
    true,
    "no `open-pr` job — PR creation left the run and the gate is gone with it",
  );

  const createPr = ((openPr!.steps ?? []) as readonly EnvStep[])
    .find((s) => s.name === "create-pr");
  assertEquals(createPr !== undefined, true, "no `create-pr` step");

  const env = createPr!.task?.inputs?.env ?? {};
  const referencesRecord = Object.values(env).some((value) =>
    value.includes("attestationRecord-main")
  );
  assertEquals(
    referencesRecord,
    true,
    "create-pr must read attestationRecord-main, the resource written only " +
      "when swamp-club accepts an attestation. Without that input the step " +
      "can run with no attestation behind it.",
  );
});

Deno.test("submit-change: link-pr records the URL the run produced", async () => {
  // Not the URL an agent typed: the recorded output of the step that created
  // the PR.
  const workflow = await readReviewsWorkflow();
  const linkPr = (((workflow.jobs ?? []).find((j) => j.name === "open-pr")
    ?.steps ?? []) as readonly EnvStep[]).find((s) => s.name === "link-pr");

  assertEquals(linkPr !== undefined, true, "no `link-pr` step");
  assertStringIncludes(
    linkPr!.task?.inputs?.url ?? "",
    "data.latest('submit-create-pr-' + run.id, 'result')",
  );
});

Deno.test("submit-change: the recorded checklist comes from the attestation", async () => {
  // verification_passed gates link_pr. Supplying it a step list assembled
  // outside the run would put agent testimony back under the gate the
  // attestation exists to replace.
  const workflow = await readReviewsWorkflow();
  const record = (((workflow.jobs ?? [])
    .find((j) => j.name === "record-verification")?.steps ??
    []) as readonly EnvStep[])[0];

  assertEquals(record !== undefined, true, "no `record-verification` step");
  const inputs = record!.task?.inputs ?? {};
  assertStringIncludes(
    inputs.attestation ?? "",
    "data.latest('submit-attest-' + run.id, 'result')",
  );
  assertEquals(
    "steps" in inputs,
    false,
    "record-verification must not pass its own step list",
  );
});

Deno.test("submit-change: create-pr reuses an open PR instead of failing", async () => {
  // Re-running is the normal case, not an edge case. CI validates that the
  // attestation's commit equals the PR head, so every push to an open PR needs
  // a fresh attestation for the new SHA, and the pr_failed recovery loop
  // re-verifies against a PR that is already open. `gh pr create` refuses a
  // second PR for the same branch, so a step that always creates would break
  // both loops at exactly the point a human is waiting on it.
  const workflow = await readReviewsWorkflow();
  const createPr = (((workflow.jobs ?? []).find((j) => j.name === "open-pr")
    ?.steps ?? []) as readonly EnvStep[]).find((s) => s.name === "create-pr");

  const shell = createPr?.task?.inputs?.run ?? "";
  assertStringIncludes(
    shell,
    "gh pr list",
    "create-pr must look for an existing open PR on the branch before " +
      "calling `gh pr create`, which fails when one already exists",
  );
});

Deno.test("submit-change: the diff and PR bases are inputs, never hardcoded", async () => {
  // A branch stacked on another must diff against its parent, or the agent
  // reviews see the union with everything the parent already had reviewed —
  // re-reviewing thousands of lines at four large-model calls, and burying the
  // change actually under review. `main` was hardcoded in ten places.
  const source = await Deno.readTextFile(REVIEWS_WORKFLOW);
  const offenders = source
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) =>
      // Comments and the input defaults are where `main` legitimately appears.
      !line.startsWith("#") &&
      (/base:\s*"origin\/main"/.test(line) ||
        /merge-base\s+origin\/main\b/.test(line) ||
        /--base\s+main\b/.test(line))
    )
    .map(({ line, n }) => `${n}: ${line}`);

  assertEquals(
    offenders,
    [],
    "Use ${{ inputs.diffBase }} and ${{ inputs.prBase }} rather than a " +
      `hardcoded main. Offenders: ${offenders.join("; ")}`,
  );
});
