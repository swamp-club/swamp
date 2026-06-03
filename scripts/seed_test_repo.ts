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
 * Seeds a test repo in /tmp/swamp-tag-test and prints CLI commands
 * to exercise definition tags → data, workflow tags → data, and
 * --tag runtime overrides.
 *
 * Usage:
 *   deno run --allow-all scripts/seed_test_repo.ts
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";

const REPO = "/tmp/swamp-tag-test";
const SWAMP = join(REPO, ".swamp");
const SRC = Deno.cwd(); // assumes we run from the swamp repo root
const MAIN = join(SRC, "main.ts");
const DENO_ARGS = [
  "run",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  "--allow-net",
  MAIN,
];

// ── helpers ──────────────────────────────────────────────────────────

async function swamp(...args: string[]): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: [...DENO_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  if (err.trim()) console.error("  stderr:", err.trim());
  return out.trim();
}

async function writeYaml(path: string, data: Record<string, unknown>) {
  await ensureDir(join(path, ".."));
  const content = stringifyYaml(
    JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
  );
  await Deno.writeTextFile(path, content);
}

// ── main ─────────────────────────────────────────────────────────────

// Clean slate
try {
  await Deno.remove(REPO, { recursive: true });
} catch { /* ok */ }
await ensureDir(REPO);

console.log("=== Seeding test repo at", REPO, "===\n");

// 1. Init — `init` takes a positional path argument
console.log("1. Initializing repo...");
console.log(await swamp("init", REPO));

// 2. Create echo models with definition-level tags
console.log("\n2. Creating echo models...");
console.log(
  await swamp("model", "create", "swamp/echo", "echo-dev", "--repo-dir", REPO),
);
console.log(
  await swamp(
    "model",
    "create",
    "swamp/echo",
    "echo-prod",
    "--repo-dir",
    REPO,
  ),
);

// Patch the definitions to include tags and a message
const defsDir = join(SWAMP, "definitions", "swamp", "echo");
const devDefs: string[] = [];
const prodDefs: string[] = [];
for await (const entry of Deno.readDir(defsDir)) {
  if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
  const path = join(defsDir, entry.name);
  const text = await Deno.readTextFile(path);
  if (text.includes("echo-dev")) {
    devDefs.push(path);
  } else if (text.includes("echo-prod")) {
    prodDefs.push(path);
  }
}

// Patch echo-dev: tags { env: dev, team: platform }, method arg message
for (const path of devDefs) {
  const text = await Deno.readTextFile(path);
  const patched = text
    .replace(
      /tags:\s*\{\}/,
      "tags:\n  env: dev\n  team: platform",
    )
    .replace(
      /methods:\s*\{\}/,
      'methods:\n  write:\n    arguments:\n      message: "Hello from dev"',
    );
  await Deno.writeTextFile(path, patched);
}

// Patch echo-prod: tags { env: prod, team: infra }, method arg message
for (const path of prodDefs) {
  const text = await Deno.readTextFile(path);
  const patched = text
    .replace(
      /tags:\s*\{\}/,
      "tags:\n  env: prod\n  team: infra",
    )
    .replace(
      /methods:\s*\{\}/,
      'methods:\n  write:\n    arguments:\n      message: "Hello from prod"',
    );
  await Deno.writeTextFile(path, patched);
}

console.log("  Patched echo-dev with tags: { env: dev, team: platform }");
console.log("  Patched echo-prod with tags: { env: prod, team: infra }");

// 3. Create a workflow with tags
console.log("\n3. Creating workflow...");
console.log(
  await swamp("workflow", "create", "deploy-pipeline", "--repo-dir", REPO),
);

// Find the workflow file and rewrite it with tags and steps
const workflowsDir = join(SWAMP, "workflows");
let workflowPath = "";
let workflowId = "";
for await (const entry of Deno.readDir(workflowsDir)) {
  if (entry.isFile && entry.name.endsWith(".yaml")) {
    const path = join(workflowsDir, entry.name);
    const text = await Deno.readTextFile(path);
    if (text.includes("deploy-pipeline")) {
      workflowPath = path;
      // Extract ID from filename: workflow-<uuid>.yaml
      const match = entry.name.match(/workflow-(.+)\.yaml/);
      if (match) workflowId = match[1];
    }
  }
}

if (workflowPath) {
  const workflowData = {
    id: workflowId,
    name: "deploy-pipeline",
    description: "Test workflow with tags that runs both echo models",
    tags: {
      project: "alpha",
      region: "us-east-1",
    },
    version: 1,
    jobs: [
      {
        name: "run-echoes",
        steps: [
          {
            name: "echo-dev-step",
            task: {
              type: "model_method",
              modelIdOrName: "echo-dev",
              methodName: "write",
            },
            dependsOn: [],
            weight: 0,
          },
          {
            name: "echo-prod-step",
            task: {
              type: "model_method",
              modelIdOrName: "echo-prod",
              methodName: "write",
            },
            dependsOn: [],
            weight: 0,
          },
        ],
        dependsOn: [],
        weight: 0,
      },
    ],
  };
  await writeYaml(workflowPath, workflowData);
  console.log(
    "  Rewrote workflow with tags: { project: alpha, region: us-east-1 }",
  );
}

// ── print the test plan ──────────────────────────────────────────────

const RUN = `deno run --allow-all ${MAIN}`;
const RD = `--repo-dir ${REPO}`;

console.log(`
${"=".repeat(70)}
TEST PLAN — Tag Propagation (Issue #174)
${"=".repeat(70)}

Repo seeded at: ${REPO}

Shorthand used below:
  RUN = ${RUN}
  RD  = ${RD}

──────────────────────────────────────────────────────────────────────
TEST 1: Definition tags flow to data
──────────────────────────────────────────────────────────────────────

Run the "echo-dev" model (has tags: env=dev, team=platform):

  ${RUN} model method run echo-dev write ${RD}

Then search for data with those tags:

  ${RUN} data search --tag env=dev ${RD}
  ${RUN} data search --tag team=platform ${RD}

Both should return the data produced by echo-dev.

Run "echo-prod" (has tags: env=prod, team=infra):

  ${RUN} model method run echo-prod write ${RD}

Search by tag to find only prod data:

  ${RUN} data search --tag env=prod ${RD}

Should return echo-prod data only. Search for team=platform should
return only echo-dev data:

  ${RUN} data search --tag team=platform ${RD}

──────────────────────────────────────────────────────────────────────
TEST 2: Runtime --tag overrides definition tags
──────────────────────────────────────────────────────────────────────

Run echo-dev with a runtime tag that overrides env:

  ${RUN} model method run echo-dev write --tag env=staging ${RD}

Search for env=staging — should find this run's data:

  ${RUN} data search --tag env=staging ${RD}

Search for env=dev — should NOT find the latest run (it was
overridden to staging). Prior runs with env=dev still match.

──────────────────────────────────────────────────────────────────────
TEST 3: Runtime --tag adds new tags
──────────────────────────────────────────────────────────────────────

Run echo-dev with an extra tag:

  ${RUN} model method run echo-dev write --tag runId=abc123 ${RD}

Search for the new tag:

  ${RUN} data search --tag runId=abc123 ${RD}

Should find exactly the data from this run.

──────────────────────────────────────────────────────────────────────
TEST 4: Workflow tags flow to data
──────────────────────────────────────────────────────────────────────

Run the deploy-pipeline workflow (tags: project=alpha, region=us-east-1):

  ${RUN} workflow run deploy-pipeline ${RD}

Search for workflow tags on the produced data:

  ${RUN} data search --tag project=alpha ${RD}
  ${RUN} data search --tag region=us-east-1 ${RD}

Both should return the data produced by the workflow steps.
The data should also have the definition-level tags (env, team).

──────────────────────────────────────────────────────────────────────
TEST 5: Workflow run with --tag runtime override
──────────────────────────────────────────────────────────────────────

Run the workflow with a runtime tag:

  ${RUN} workflow run deploy-pipeline --tag env=canary ${RD}

Search for env=canary:

  ${RUN} data search --tag env=canary ${RD}

Should find data from both steps of this workflow run.

──────────────────────────────────────────────────────────────────────
TEST 6: Combined tag search (AND logic)
──────────────────────────────────────────────────────────────────────

  ${RUN} data search --tag env=dev --tag team=platform ${RD}

Should match only echo-dev data (not echo-prod).

  ${RUN} data search --tag project=alpha --tag env=canary ${RD}

Should match only data from the --tag env=canary workflow run.

──────────────────────────────────────────────────────────────────────
TEST 7: Browse all data with tags
──────────────────────────────────────────────────────────────────────

  ${RUN} data search --json ${RD} | head -100

${"=".repeat(70)}
`);
