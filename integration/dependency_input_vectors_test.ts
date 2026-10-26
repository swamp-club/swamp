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
 * The dependency input vectors (swamp-club#3969): one directory per input
 * form an author can push, each an `input.yaml` (the files of a project, the
 * packages installed in its node_modules) and an `expected.json` (what push,
 * quality, fmt and the loader make of it). Each runs against real Deno, so
 * a Deno upgrade that changes how a form resolves fails the vector that
 * names it instead of changing what ships.
 *
 * Each vector's tree is written to a temporary directory and run by
 * dependency_input_vectors_driver.ts in a Deno process whose working
 * directory is the vector's repository, as an author runs push. The
 * registries are local (dependency_input_vectors_registry.ts).
 *
 * Run with SWAMP_UPDATE_INPUT_VECTORS=1 to write each expected.json from
 * what the code does now; review the diff before keeping it.
 */

import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  startVectorRegistry,
  type VectorRegistry,
} from "./dependency_input_vectors_registry.ts";
import { SHARED_SWAMP_DENO_CACHE } from "./test_helpers.ts";

const HERE = dirname(fromFileUrl(import.meta.url));

const VECTORS_DIR = join(
  HERE,
  "..",
  "src",
  "domain",
  "extensions",
  "dependency_resolution",
  "testdata",
  "dependency_input_vectors",
);

const DRIVER = join(HERE, "dependency_input_vectors_driver.ts");

/** swamp's own config, for the driver's imports: never the vector's. */
const SWAMP_CONFIG = join(HERE, "..", "deno.json");

const UPDATE = Deno.env.get("SWAMP_UPDATE_INPUT_VECTORS") === "1";

/** A vector's input.yaml. */
interface VectorInput {
  description: string;
  /** The repository directory within the tree; the tree root by default. */
  repo?: string;
  /** The manifest, relative to the repository; `manifest.yaml` by default. */
  manifest?: string;
  /** Every file of the tree, by forward-slash path. */
  files: Record<string, string>;
  /** Packages installed in a node_modules, as an installer leaves them. */
  installed?: {
    /** The package's directory in the tree (`node_modules/vecpkg`). */
    dir: string;
    name: string;
    version: string;
  }[];
}

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** Writes the vector's tree under `root` and initializes its repository. */
async function writeTree(
  root: string,
  input: VectorInput,
  registry: VectorRegistry,
): Promise<string> {
  for (const [path, text] of Object.entries(input.files)) {
    await write(join(root, ...path.split("/")), registry.substitute(text));
  }
  for (const pkg of input.installed ?? []) {
    const dir = join(root, ...pkg.dir.split("/"));
    await write(
      join(dir, "package.json"),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        type: "module",
        main: "index.js",
      }) + "\n",
    );
    await write(
      join(dir, "index.js"),
      `export default ${JSON.stringify(`${pkg.name}@${pkg.version}`)};\n` +
        "export const z = {};\n",
    );
  }
  const repoDir = join(root, ...(input.repo ?? ".").split("/"));
  const version = "20260101.120000.0";
  const events = await collect(
    repoInit(createLibSwampContext(), createRepoInitDeps(version), {
      path: repoDir,
      force: false,
      version,
      tools: [],
    }),
  );
  assertEquals(events.filter((e) => e.kind === "error"), []);
  return repoDir;
}

/** Runs the driver over the vector written at `root`; returns its outcome. */
async function runDriver(
  root: string,
  repoDir: string,
  input: VectorInput,
  registry: VectorRegistry,
): Promise<unknown> {
  const outPath = join(root, "outcome.json");
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--no-check",
      "--unstable-bundle",
      "--config",
      SWAMP_CONFIG,
      DRIVER,
      root,
      repoDir,
      join(repoDir, ...(input.manifest ?? "manifest.yaml").split("/")),
      registry.origin,
      outPath,
    ],
    cwd: repoDir,
    env: { SWAMP_NO_TELEMETRY: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `the vector driver failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return JSON.parse(await Deno.readTextFile(outPath));
}

/** Removes what Deno cached from this run's registry in the shared cache. */
async function forgetRegistry(registry: VectorRegistry): Promise<void> {
  const port = new URL(registry.origin).port;
  for (
    const dir of [
      join(SHARED_SWAMP_DENO_CACHE, "npm", port),
      join(SHARED_SWAMP_DENO_CACHE, "remote", "http", `127.0.0.1_PORT${port}`),
      join(SHARED_SWAMP_DENO_CACHE, "remote", "http", `127.0.0.1_port_${port}`),
    ]
  ) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const vectorNames: string[] = [];
for await (const entry of Deno.readDir(VECTORS_DIR)) {
  if (entry.isDirectory) vectorNames.push(entry.name);
}
vectorNames.sort();

Deno.test("dependency input vectors", async (t) => {
  const registry = await startVectorRegistry();
  try {
    for (const name of vectorNames) {
      await t.step(name, async () => {
        const dir = join(VECTORS_DIR, name);
        const input = parseYaml(
          await Deno.readTextFile(join(dir, "input.yaml")),
        ) as VectorInput;
        const root = await Deno.realPath(
          await Deno.makeTempDir({ prefix: `swamp-input-vector-${name}-` }),
        );
        let outcome: unknown;
        try {
          const repoDir = await writeTree(root, input, registry);
          outcome = await runDriver(root, repoDir, input, registry);
        } finally {
          await Deno.remove(root, { recursive: true }).catch((error) => {
            if (Deno.build.os !== "windows") throw error;
          });
        }
        const expectedPath = join(dir, "expected.json");
        if (UPDATE) {
          await Deno.writeTextFile(
            expectedPath,
            JSON.stringify(outcome, null, 2) + "\n",
          );
          return;
        }
        assertEquals(
          outcome,
          JSON.parse(await Deno.readTextFile(expectedPath)),
          `vector ${name}: ${input.description}`,
        );
      });
    }
  } finally {
    await registry.shutdown();
    await forgetRegistry(registry);
  }
});
