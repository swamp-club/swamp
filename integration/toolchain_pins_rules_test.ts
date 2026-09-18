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

// Architectural fitness test: every deno pin in the repository derives from
// `.tool-versions`. Deno has no native per-project version pinning, so nothing
// but this test stops the Dockerfile and the CI workflows drifting apart again
// (they did: the Dockerfile sat on 2.8.3 while CI ran 2.9.x).
//
// The count assertions are load-bearing. A renamed file or a pattern that
// quietly stops matching would otherwise turn every check below into a vacuous
// pass — the same trap arch_fitness_helpers.ts documents for path arithmetic.

import { assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { repoRelative, ROOT } from "./arch_fitness_helpers.ts";

const TOOL_VERSIONS = join(ROOT, ".tool-versions");
const DOCKERFILE = join(ROOT, "Dockerfile");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

/**
 * Workflow files expected to set up deno, and how many setup-deno steps each
 * one carries. Pinned deliberately: a new workflow that installs deno has to
 * be added here consciously, which is the moment to ask whether it should read
 * the pin like everything else.
 */
const EXPECTED_SETUP_STEPS: Record<string, number> = {
  "release.yml": 1,
  "publish-testing.yml": 1,
  "publish-client.yml": 1,
  "multi-model-eval.yml": 2,
  "windows-compat.yml": 1,
};

const EXPECTED_SETUP_TOTAL = Object.values(EXPECTED_SETUP_STEPS)
  .reduce((sum, count) => sum + count, 0);

/**
 * `verification/container/` is intentionally not checked here. It is dead code
 * still pinned at deno 2.8.3, being removed under swamp-club#2271 along with
 * the stale AGENTS.md instruction that points at it. Delete this note and the
 * exclusion together with that directory — do not "fix" it by adding those
 * pins to this test.
 */

/** The deno version `.tool-versions` pins, parsed as setup-deno parses it. */
async function readPinnedVersion(): Promise<string> {
  const contents = await Deno.readTextFile(TOOL_VERSIONS);
  const match = contents.match(/^deno\s+v?(\S+)\s*$/m);
  if (match === null) {
    throw new Error(
      `${
        repoRelative(TOOL_VERSIONS)
      } has no "deno <version>" line; it is the ` +
        `single source of truth for the deno toolchain and must pin one`,
    );
  }
  return match[1];
}

type WorkflowStep = { uses?: unknown; with?: Record<string, unknown> };
type WorkflowJob = { steps?: WorkflowStep[] };
type Workflow = { jobs?: Record<string, WorkflowJob> };

/** Every setup-deno step in a parsed workflow, in file order. */
function setupDenoSteps(workflow: Workflow): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (
        typeof step.uses === "string" &&
        step.uses.startsWith("denoland/setup-deno@")
      ) {
        steps.push(step);
      }
    }
  }
  return steps;
}

/** Parses every `.yml`/`.yaml` file under `.github/workflows/`. */
async function readWorkflows(): Promise<Map<string, Workflow>> {
  const workflows = new Map<string, Workflow>();
  for await (const entry of Deno.readDir(WORKFLOWS_DIR)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
    const contents = await Deno.readTextFile(join(WORKFLOWS_DIR, entry.name));
    workflows.set(entry.name, parseYaml(contents) as Workflow);
  }
  return workflows;
}

Deno.test("Dockerfile base image matches the .tool-versions deno pin", async () => {
  const pinned = await readPinnedVersion();
  const dockerfile = await Deno.readTextFile(DOCKERFILE);

  const matches = [...dockerfile.matchAll(/^FROM denoland\/deno:(\S+)/gm)];
  assertEquals(
    matches.length,
    1,
    `expected exactly one "FROM denoland/deno:" line in ` +
      `${repoRelative(DOCKERFILE)}, found ${matches.length} — if the ` +
      `Dockerfile changed shape, update this test rather than deleting it`,
  );

  assertEquals(
    matches[0][1],
    pinned,
    `${repoRelative(DOCKERFILE)} pins deno ${matches[0][1]} but ` +
      `.tool-versions pins ${pinned}. The Dockerfile cannot read ` +
      `.tool-versions at build time (release.yml copies only the Dockerfile ` +
      `and the binary into the build context), so the two are kept in step by ` +
      `this test. Update the Dockerfile to match .tool-versions.`,
  );
});

Deno.test("every setup-deno step reads the version from .tool-versions", async () => {
  const workflows = await readWorkflows();
  const offenders: string[] = [];
  const counts: Record<string, number> = {};
  let total = 0;

  for (const [name, workflow] of workflows) {
    const steps = setupDenoSteps(workflow);
    if (steps.length > 0) {
      counts[name] = steps.length;
      total += steps.length;
    }

    for (const step of steps) {
      const inputs = step.with ?? {};
      if ("deno-version" in inputs) {
        offenders.push(
          `.github/workflows/${name} pins deno-version: ${
            String(inputs["deno-version"])
          } — replace it with "deno-version-file: .tool-versions" so CI reads ` +
            `the same pin as local dev. If this workflow deliberately tests ` +
            `another version (canary, LTS, a matrix), add it to an explicit ` +
            `allowlist in this test rather than removing this assertion.`,
        );
        continue;
      }
      if (inputs["deno-version-file"] !== ".tool-versions") {
        offenders.push(
          `.github/workflows/${name} sets deno-version-file: ` +
            `${String(inputs["deno-version-file"])} — it must be ` +
            `".tool-versions", the single source of truth for the toolchain`,
        );
      }
    }
  }

  assertEquals(
    offenders,
    [],
    `deno version pins drifted from .tool-versions:\n${offenders.join("\n")}`,
  );

  // Without these, a renamed workflow or a `uses:` line that stops matching
  // would leave the loop above with nothing to check and still pass.
  assertEquals(
    counts,
    EXPECTED_SETUP_STEPS,
    `the set of workflows installing deno changed. Update ` +
      `EXPECTED_SETUP_STEPS in this test, and make sure any new workflow uses ` +
      `"deno-version-file: .tool-versions".`,
  );
  assertEquals(
    total,
    EXPECTED_SETUP_TOTAL,
    `expected ${EXPECTED_SETUP_TOTAL} setup-deno steps across the workflows, ` +
      `found ${total}`,
  );
});
