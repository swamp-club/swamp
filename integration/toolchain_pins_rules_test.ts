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
import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { repoRelative, ROOT } from "./arch_fitness_helpers.ts";
import { litestreamArchiveUrl } from "../src/domain/datastore_v3/litestream_release.ts";
import { LITESTREAM_PIN } from "../src/infrastructure/datastore_v3/litestream/litestream_pin.ts";

const TOOL_VERSIONS = join(ROOT, ".tool-versions");
const DOCKERFILE = join(ROOT, "Dockerfile");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

const EXPECTED_SETUP_STEPS: Record<string, number> = {
  "release.yml": 2,
  "publish-testing.yml": 1,
  "publish-client.yml": 1,
  "publish-extension-scoring.yml": 1,
  "windows-compat.yml": 1,
  "flaky-tests.yml": 1,
};

const EXPECTED_SETUP_TOTAL = Object.values(EXPECTED_SETUP_STEPS)
  .reduce((sum, count) => sum + count, 0);

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

Deno.test("Dockerfile runs swamp under tini as a child subreaper", async () => {
  const dockerfile = await Deno.readTextFile(DOCKERFILE);

  const entrypoints = [...dockerfile.matchAll(/^ENTRYPOINT\s+(.+)$/gm)];
  assertEquals(
    entrypoints.length,
    1,
    `expected exactly one ENTRYPOINT line in ${repoRelative(DOCKERFILE)}, ` +
      `found ${entrypoints.length} — if the Dockerfile changed shape, update ` +
      `this test rather than deleting it`,
  );

  assertEquals(
    JSON.parse(entrypoints[0][1]),
    ["/tini", "-s", "--", "swamp"],
    `${repoRelative(DOCKERFILE)} must start swamp through the base image's ` +
      `tini. As PID 1, swamp never reaps the orphaned processes steps leave ` +
      `behind, so they stay zombies until the container exits ` +
      `(swamp-club#2652).`,
  );

  assertEquals(
    /^RUN .*test -x \/tini\b/m.test(dockerfile),
    true,
    `${repoRelative(DOCKERFILE)} must check at build time that /tini exists, ` +
      `so a base image without it fails the build instead of shipping an ` +
      `image whose entrypoint cannot start`,
  );
});

Deno.test("Dockerfile bakes in the pinned Litestream and points swamp at it", async () => {
  const dockerfile = await Deno.readTextFile(DOCKERFILE);
  const stages: Record<string, "linux-x86_64" | "linux-arm64"> = {
    amd64: "linux-x86_64",
    arm64: "linux-arm64",
  };
  for (const [arch, target] of Object.entries(stages)) {
    const expected = `FROM scratch AS litestream-${arch}\n` +
      `ADD --checksum=sha256:${LITESTREAM_PIN.digests(target).archiveSha256} ${
        litestreamArchiveUrl(LITESTREAM_PIN.version, target)
      } /litestream.tar.gz\n`;
    assertEquals(
      dockerfile.includes(expected),
      true,
      `${repoRelative(DOCKERFILE)} must fetch Litestream ` +
        `${LITESTREAM_PIN.version} for ${target} with the pinned archive ` +
        `digest. Run \`deno run litestream-pin --version ` +
        `${LITESTREAM_PIN.version}\` to rewrite it from the pin.`,
    );
  }
  assertEquals(
    /^ENV SWAMP_LITESTREAM_PATH=\/usr\/local\/bin\/litestream$/m.test(
      dockerfile,
    ),
    true,
    `${repoRelative(DOCKERFILE)} must point SWAMP_LITESTREAM_PATH at the ` +
      `baked-in binary, so serve never downloads Litestream at runtime`,
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

Deno.test("the Go toolchain is pinned once and the eval tool needs no modules", async () => {
  const contents = await Deno.readTextFile(TOOL_VERSIONS);
  const pinned = contents.match(/^golang\s+(\d+)\.(\d+)\.\d+\s*$/m);
  assertEquals(
    pinned !== null,
    true,
    `${repoRelative(TOOL_VERSIONS)} has no "golang <x.y.z>" line`,
  );

  const goMod = await Deno.readTextFile(
    join(ROOT, "tools", "swamp-eval", "go.mod"),
  );
  const directive = goMod.match(/^go\s+(\d+)\.(\d+)/m);
  assertEquals(
    directive !== null,
    true,
    "tools/swamp-eval/go.mod has no go directive",
  );
  const [needMajor, needMinor] = [Number(directive![1]), Number(directive![2])];
  const [pinMajor, pinMinor] = [Number(pinned![1]), Number(pinned![2])];
  assertEquals(
    needMajor < pinMajor || (needMajor === pinMajor && needMinor <= pinMinor),
    true,
    "tools/swamp-eval/go.mod requires a newer Go than .tool-versions pins",
  );
  assertEquals(
    /^\s*(require|replace)\b/m.test(goMod),
    false,
    "tools/swamp-eval must stay standard-library only: go.mod may not " +
      "require or replace modules",
  );

  const offenders: string[] = [];
  let setupGo = 0;
  for (const [name, workflow] of await readWorkflows()) {
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (
          typeof step.uses !== "string" ||
          !step.uses.startsWith("actions/setup-go@")
        ) {
          continue;
        }
        setupGo++;
        if (step.with?.["go-version-file"] !== ".tool-versions") {
          offenders.push(
            `.github/workflows/${name} must set go-version-file: .tool-versions`,
          );
        }
      }
    }
  }
  assertEquals(
    setupGo > 0,
    true,
    "no setup-go step found; the rule would pass vacuously",
  );
  assertEquals(offenders, [], offenders.join("\n"));
});
