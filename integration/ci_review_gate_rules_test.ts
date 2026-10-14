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

// Architectural fitness test: each CI review gate reads the verdict for the
// commit under review.
//
// swamp-club#3425 / #3422: Claude Code refuses a Bash command whose quoted
// argument has a line starting with `#`, so a reviewer told to post a `##`
// heading in `--body "..."` retried until a bold-heading variant got through.
// The gates matched only `^(## )?<Heading>`, skipped the bold review, and read
// an older review on another commit instead — blocking a passing PR, or
// letting an older pass stand in for a newer failure.
//
// The gates now match the heading with or without markdown emphasis, keep
// only the review for the head commit, and fail when that review is missing.
// The prompts post the body on stdin through a quoted heredoc, which the
// permission check allows. These rules pin that shape.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const ADVERSARIAL_ACTION = join(
  ROOT,
  ".github",
  "actions",
  "adversarial-review",
  "action.yml",
);

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Gate {
  heading: string;
  file: string;
  steps: Step[];
  /** Name of the step that runs the reviewer. */
  reviewStep: string;
}

async function loadGates(): Promise<Gate[]> {
  const ci = parse(await Deno.readTextFile(CI_WORKFLOW)) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const action = parse(await Deno.readTextFile(ADVERSARIAL_ACTION)) as {
    runs: { steps?: Step[] };
  };
  return [
    {
      heading: "Adversarial Review",
      file: ADVERSARIAL_ACTION,
      steps: action.runs.steps ?? [],
      reviewStep: "Adversarial Code Review",
    },
    {
      heading: "CI Security Review",
      file: CI_WORKFLOW,
      steps: ci.jobs["claude-ci-security-review"]?.steps ?? [],
      reviewStep: "CI Security Review",
    },
    {
      heading: "Review Integrity",
      file: CI_WORKFLOW,
      steps: ci.jobs["claude-review-integrity"]?.steps ?? [],
      reviewStep: "Review Integrity Check",
    },
  ];
}

function stepNamed(gate: Gate, name: string): Step {
  const step = gate.steps.find((s) => s.name === name);
  if (!step) {
    throw new Error(
      `No "${name}" step for the ${gate.heading} gate in ${gate.file} — it ` +
        "was renamed, which would make these rules a vacuous pass.",
    );
  }
  return step;
}

/**
 * Every jq `test("...")` pattern in a file that names the heading, decoded
 * from its jq string literal so the RegExp is the one jq runs.
 */
function headingPatterns(text: string, heading: string): RegExp[] {
  const literals = text.match(/test\(("(?:[^"\\]|\\.)*")\)/g) ?? [];
  return literals
    .map((call) => JSON.parse(call.slice("test(".length, -1)) as string)
    .filter((pattern) => pattern.includes(heading))
    .map((pattern) => new RegExp(pattern));
}

Deno.test("ci review gates: the heading matches with or without markdown emphasis", async () => {
  for (const gate of await loadGates()) {
    const patterns = headingPatterns(
      await Deno.readTextFile(gate.file),
      gate.heading,
    );
    assert(
      patterns.length > 0,
      `No review heading pattern for ${gate.heading} in ${gate.file}.`,
    );
    for (const pattern of patterns) {
      for (
        const body of [
          `## ${gate.heading}\n\n### Verdict\nPASS`,
          `# ${gate.heading}\n`,
          `**${gate.heading}**\n\n**Verdict**: PASS`,
          `${gate.heading}\n`,
        ]
      ) {
        assert(
          pattern.test(body),
          `${pattern} in ${gate.file} does not match a review starting ` +
            `${JSON.stringify(body.split("\n")[0])} — the gate would skip ` +
            "it and read an older review instead.",
        );
      }
      assert(
        !pattern.test("## Attestation Approved\n"),
        `${pattern} matches the attestation review.`,
      );
    }
  }
});

Deno.test("ci review gates: the fail step reads only the head commit's review and fails closed", async () => {
  for (const gate of await loadGates()) {
    const step = stepNamed(gate, "Fail if changes requested");
    assertEquals(
      step.env?.HEAD_SHA,
      "${{ github.event.pull_request.head.sha }}",
      `The ${gate.heading} fail step must get the head sha through env.`,
    );
    const run = step.run ?? "";
    assertStringIncludes(
      run,
      ".commit.oid == env.HEAD_SHA",
      `The ${gate.heading} fail step must keep only reviews for the head ` +
        "commit, or a review on an older commit decides the verdict.",
    );
    assertStringIncludes(
      run,
      "APPROVED|COMMENTED) ;;",
      `The ${gate.heading} fail step must pass only on APPROVED or COMMENTED.`,
    );
    assert(
      /\*\)\s*\n[^;]*exit 1/.test(run),
      `The ${gate.heading} fail step must fail when no review was posted ` +
        "for the head commit.",
    );
  }
});

Deno.test("ci review gates: each reviewer posts its body on stdin through a quoted heredoc", async () => {
  for (const gate of await loadGates()) {
    const prompt = stepNamed(gate, gate.reviewStep).with?.prompt ?? "";
    assert(prompt.length > 0, `No prompt for the ${gate.heading} reviewer.`);
    assertStringIncludes(
      prompt,
      `--body-file - <<'EOF'\n## ${gate.heading}\n`,
      `The ${gate.heading} prompt must show the heredoc submit form with ` +
        "the heading inside it.",
    );
    assert(
      !prompt.includes('--body "'),
      `The ${gate.heading} prompt still shows a quoted --body argument, ` +
        "which Claude Code refuses when the body has # lines.",
    );
  }
});

Deno.test("ci review gates: a change to a local action gets the CI security review", async () => {
  const ci = parse(await Deno.readTextFile(CI_WORKFLOW)) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const filters = ci.jobs["changes"]?.steps?.find((s) => s.with?.filters)
    ?.with?.filters;
  if (!filters) {
    throw new Error("No paths filter in the changes job of ci.yml.");
  }
  const parsed = parse(filters) as Record<string, string[]>;
  assert(
    parsed.ci?.includes(".github/actions/**"),
    "The ci path filter must cover .github/actions/**, which holds the " +
      "adversarial review's prompt and gate.",
  );
});
