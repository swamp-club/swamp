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
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import fc from "fast-check";
import { ExtensionWorkflowRepository } from "./extension_workflow_repository.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { workflowListingOf } from "../../domain/workflows/workflow_listing.ts";

const DIRS = ["base", "pulled", "extra"] as const;
const FILES = ["a.yaml", "b.yml", join("nested", "c.yaml")];
const NAMES = ["alpha", "beta", "gamma"];
const IDS = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const ADDITIONAL_DIR_SETS: Array<Array<typeof DIRS[number]>> = [
  [],
  ["pulled"],
  ["extra"],
  ["pulled", "extra"],
  ["extra", "pulled"],
];

type Content =
  | { kind: "workflow"; name: string; id: string; inputs: boolean }
  | { kind: "invalid"; name: string; id: string }
  | { kind: "unparseable" }
  | { kind: "data"; name: string };

type Op =
  | {
    kind: "write" | "replace";
    dir: typeof DIRS[number];
    file: string;
    content: Content;
    keepMtime: boolean;
  }
  | { kind: "remove"; dir: typeof DIRS[number]; file: string }
  | { kind: "dirs"; additional: Array<typeof DIRS[number]> };

const contentArb: fc.Arbitrary<Content> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("workflow" as const),
      name: fc.constantFrom(...NAMES),
      id: fc.constantFrom(...IDS),
      inputs: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("invalid" as const),
      name: fc.constantFrom(...NAMES),
      id: fc.constantFrom(...IDS),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "unparseable" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("data" as const),
      name: fc.constantFrom(...NAMES),
    }),
  },
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constantFrom("write" as const, "replace" as const),
      dir: fc.constantFrom(...DIRS),
      file: fc.constantFrom(...FILES),
      content: contentArb,
      keepMtime: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("remove" as const),
      dir: fc.constantFrom(...DIRS),
      file: fc.constantFrom(...FILES),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("dirs" as const),
      additional: fc.constantFrom(...ADDITIONAL_DIR_SETS),
    }),
  },
);

function render(content: Content): string {
  const job = {
    name: "job",
    steps: [{
      name: "step",
      task: {
        type: "model_method",
        modelIdOrName: "model",
        methodName: "method",
      },
    }],
  };
  switch (content.kind) {
    case "workflow":
      return stringifyYaml({
        id: content.id,
        name: content.name,
        version: 1,
        ...(content.inputs
          ? { inputs: { properties: { env: { type: "string" } } } }
          : {}),
        jobs: [job],
      });
    case "invalid":
      // declares a name and id but fails the schema, so findAll skips it
      return stringifyYaml({
        id: content.id,
        name: content.name,
        version: "not-a-number",
        jobs: [job],
      });
    case "unparseable":
      return "jobs: [\n";
    case "data":
      return stringifyYaml({ name: content.name, items: [1, 2] });
  }
}

// every file is older than the racy window, so the cache keeps its listings
let clock = Date.UTC(2020, 0, 1);

async function stamp(path: string, keepMtime: boolean): Promise<void> {
  // A kept mtime is detectable only by inode, which Windows does not report;
  // the primary repository accepts the same limit.
  if (!keepMtime || Deno.build.os === "windows") clock += 1_000;
  await Deno.utime(path, new Date(clock), new Date(clock));
}

async function apply(root: string, op: Op): Promise<void> {
  if (op.kind === "dirs") return;
  const path = join(root, op.dir, op.file);
  if (op.kind === "remove") {
    await Deno.remove(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    return;
  }
  await ensureDir(dirname(path));
  if (op.kind === "write") {
    // an in-place rewrite keeps its inode, and its change time has only
    // millisecond resolution, so a kept mtime there is the accepted limit
    await Deno.writeTextFile(path, render(op.content));
    await stamp(path, false);
    return;
  }
  const staged = join(root, `staged-${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(staged, render(op.content));
  await stamp(staged, op.keepMtime);
  await Deno.rename(staged, path);
}

async function assertAnswersAsFindAll(
  repo: ExtensionWorkflowRepository,
  fresh: ExtensionWorkflowRepository,
  after: string,
): Promise<void> {
  const all = await fresh.findAll();
  assertEquals(
    await repo.findAllListings(),
    all.map(workflowListingOf),
    `listings after ${after}`,
  );
  for (const name of NAMES) {
    const found = await repo.findByName(name);
    const expected = all.find((w) => w.name === name);
    assertEquals(
      found ? [found.id, found.name] : null,
      expected ? [expected.id, expected.name] : null,
      `findByName(${name}) after ${after}`,
    );
  }
  for (const id of IDS) {
    const found = await repo.findById(id as WorkflowId);
    const expected = all.find((w) => w.id === id);
    assertEquals(
      found ? [found.id, found.name] : null,
      expected ? [expected.id, expected.name] : null,
      `findById(${id}) after ${after}`,
    );
  }
}

Deno.test("ExtensionWorkflowRepository: findByName, findById and findAllListings answer as a fresh findAll does, across edits, replaces, removes and dir changes", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(opArb, { minLength: 1, maxLength: 12 }),
      async (ops) => {
        const root = await Deno.makeTempDir({
          prefix: `swamp-ext-workflow-property-${crypto.randomUUID()}-`,
        });
        try {
          const dirOf = (d: typeof DIRS[number]) => join(root, d);
          let additional: string[] = [];
          const repo = new ExtensionWorkflowRepository(dirOf("base"));
          for (const op of ops) {
            await apply(root, op);
            if (op.kind === "dirs") {
              additional = op.additional.map(dirOf);
              repo.updateAdditionalDirs(additional);
            }
            await assertAnswersAsFindAll(
              repo,
              new ExtensionWorkflowRepository(dirOf("base"), additional),
              JSON.stringify(op),
            );
          }
        } finally {
          await Deno.remove(root, { recursive: true }).catch((error) => {
            if (Deno.build.os !== "windows") throw error;
          });
        }
      },
    ),
    { numRuns: 50 },
  );
});
