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
const REVIEWS_WORKFLOW = join(
  ROOT,
  "verification",
  "workflow-verify-reviews.yaml",
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

Deno.test("verify-reviews: the expected review steps are present", async () => {
  const steps = reviewSteps(await readReviewsWorkflow());
  assertEquals(
    steps.map((s) => s.name).sort(),
    Object.keys(EXPECTED_REVIEW_STEPS).sort(),
  );
});

Deno.test("verify-reviews: every review step delegates its verdict to the shared script", async () => {
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

Deno.test("verify-reviews: no step infers a verdict when the marker is absent", async () => {
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
    "verify-reviews must not infer a verdict from output that carries no " +
      `VERDICT marker. Offending text: ${violations.join("; ")}`,
  );
});
