#!/usr/bin/env -S deno run -A

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

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import {
  BUNDLE_DIR,
  bundleArgs,
  compileArgs,
  inlinedNpmPackages,
  npmExternals,
  type PackageJson,
  readWorkspaceConfigs,
  requireNpmExternals,
  requireRepoSources,
  restoreBuildState,
  runStampedBuild,
  sourceMapIncludes,
  stampBuildInfo,
  VERSION_FILE,
} from "./compile.ts";

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
const buildInfoPath = join(repoRoot, VERSION_FILE);

const VERSION_LINE = /^export const VERSION = .*$/m;
const GIT_SHA_LINE = /^export const GIT_SHA = .*$/m;

Deno.test("stampBuildInfo: stamps both constants in the real build info file", async () => {
  const source = await Deno.readTextFile(buildInfoPath);

  const stamped = stampBuildInfo(source, {
    version: "20990101.000000.0-sha.abc1234",
    sha: "abc1234",
  });

  assertEquals(
    stamped.match(VERSION_LINE)?.[0],
    'export const VERSION = "20990101.000000.0-sha.abc1234";',
  );
  assertEquals(
    stamped.match(GIT_SHA_LINE)?.[0],
    'export const GIT_SHA = "abc1234";',
  );
});

Deno.test("stampBuildInfo: leaves a constant whose value is not given untouched", async () => {
  const source = await Deno.readTextFile(buildInfoPath);

  const shaOnly = stampBuildInfo(source, { sha: "abc1234" });
  assertEquals(
    shaOnly.match(VERSION_LINE)?.[0],
    source.match(VERSION_LINE)?.[0],
  );
  assertNotEquals(shaOnly, source);

  assertEquals(stampBuildInfo(source, {}), source);
});

Deno.test("stampBuildInfo: throws when a requested constant is missing", () => {
  const noVersion = 'export const GIT_SHA = "";\n';
  const noSha = 'export const VERSION = "1.0.0";\n';

  assertThrows(
    () => stampBuildInfo(noVersion, { version: "2.0.0" }),
    Error,
    "no VERSION constant",
  );
  assertThrows(
    () => stampBuildInfo(noSha, { sha: "abc1234" }),
    Error,
    "no GIT_SHA constant",
  );
});

function recordingSteps(
  build: () => Promise<boolean>,
  stamp: () => Promise<void> = () => Promise.resolve(),
) {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      stamp: async () => {
        calls.push("stamp");
        await stamp();
      },
      build: async () => {
        calls.push("build");
        return await build();
      },
      restore: () => {
        calls.push("restore");
        return Promise.resolve();
      },
    },
  };
}

Deno.test("runStampedBuild: restores and reports failure when the build fails", async () => {
  const { calls, steps } = recordingSteps(() => Promise.resolve(false));
  assertEquals(await runStampedBuild(steps), false);
  assertEquals(calls, ["stamp", "build", "restore"]);
});

Deno.test("runStampedBuild: restores and reports success when the build succeeds", async () => {
  const { calls, steps } = recordingSteps(() => Promise.resolve(true));
  assertEquals(await runStampedBuild(steps), true);
  assertEquals(calls, ["stamp", "build", "restore"]);
});

Deno.test("runStampedBuild: restores and rethrows when the build throws", async () => {
  const { calls, steps } = recordingSteps(() =>
    Promise.reject(new Error("download failed"))
  );
  await assertRejects(() => runStampedBuild(steps), Error, "download failed");
  assertEquals(calls, ["stamp", "build", "restore"]);
});

Deno.test("runStampedBuild: restores without building when the stamp throws", async () => {
  const { calls, steps } = recordingSteps(
    () => Promise.resolve(true),
    () => Promise.reject(new Error("stamp failed")),
  );
  await assertRejects(() => runStampedBuild(steps), Error, "stamp failed");
  assertEquals(calls, ["stamp", "restore"]);
});

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true).catch(() => false);
}

interface BuildTree {
  versionFile: string;
  denoDir: string;
  bundleDir: string;
}

async function withBuildTree(
  run: (paths: BuildTree) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "compile-restore-" });
  try {
    const versionFile = join(root, "build_info.ts");
    const denoDir = join(root, "resources", "deno");
    const bundleDir = join(root, "build", "bundle");
    await Deno.writeTextFile(versionFile, 'export const GIT_SHA = "stamped";');
    await Deno.mkdir(denoDir, { recursive: true });
    await Deno.writeTextFile(join(denoDir, "version.txt"), "2.9.8");
    await Deno.mkdir(bundleDir, { recursive: true });
    await Deno.writeTextFile(join(bundleDir, "main.js"), "");
    await Deno.writeTextFile(join(bundleDir, "main.js.map"), "{}");
    await run({ versionFile, denoDir, bundleDir });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("restoreBuildState: rewrites the version file and removes the deno resources and the bundle", async () => {
  await withBuildTree(async ({ versionFile, denoDir, bundleDir }) => {
    await restoreBuildState(versionFile, "original", denoDir, bundleDir);
    assertEquals(await Deno.readTextFile(versionFile), "original");
    assertEquals(await exists(denoDir), false);
    assertEquals(await exists(bundleDir), false);
  });
});

Deno.test("restoreBuildState: leaves the version file alone when nothing was stamped", async () => {
  await withBuildTree(async ({ versionFile, denoDir, bundleDir }) => {
    await restoreBuildState(versionFile, undefined, denoDir, bundleDir);
    assertEquals(
      await Deno.readTextFile(versionFile),
      'export const GIT_SHA = "stamped";',
    );
    assertEquals(await exists(denoDir), false);
    assertEquals(await exists(bundleDir), false);
  });
});

Deno.test("restoreBuildState: tolerates missing deno resources", async () => {
  await withBuildTree(async ({ versionFile, denoDir, bundleDir }) => {
    await Deno.remove(denoDir, { recursive: true });
    await restoreBuildState(versionFile, "original", denoDir, bundleDir);
    assertEquals(await Deno.readTextFile(versionFile), "original");
    assertEquals(await exists(bundleDir), false);
  });
});

Deno.test("restoreBuildState: tolerates a missing bundle directory", async () => {
  await withBuildTree(async ({ versionFile, denoDir, bundleDir }) => {
    await Deno.remove(bundleDir, { recursive: true });
    await restoreBuildState(versionFile, "original", denoDir, bundleDir);
    assertEquals(await Deno.readTextFile(versionFile), "original");
    assertEquals(await exists(denoDir), false);
  });
});

Deno.test("restoreBuildState: leaves the bundle directory alone when no bundle was built", async () => {
  await withBuildTree(async ({ versionFile, denoDir, bundleDir }) => {
    await restoreBuildState(versionFile, "original", denoDir, undefined);
    assertEquals(await Deno.readTextFile(versionFile), "original");
    assertEquals(await exists(denoDir), false);
    assertEquals(await exists(join(bundleDir, "main.js")), true);
  });
});

Deno.test("restoreBuildState: removes the deno resources and the bundle when the version file write fails", async () => {
  await withBuildTree(async ({ versionFile, denoDir, bundleDir }) => {
    await Deno.remove(versionFile);
    await Deno.mkdir(versionFile);
    // the error class differs by platform, so only the rejection is asserted
    await assertRejects(() =>
      restoreBuildState(versionFile, "original", denoDir, bundleDir)
    );
    assertEquals(await exists(denoDir), false);
    assertEquals(await exists(bundleDir), false);
  });
});

// the build writes both directories before the failing step, as a real
// bundle or compile failure leaves them
function stampedBuildOver(
  tree: BuildTree,
  failingStep: () => Promise<boolean>,
) {
  const original = 'export const GIT_SHA = "";';
  return {
    original,
    steps: {
      stamp: () => Deno.writeTextFile(tree.versionFile, "stamped"),
      build: async () => {
        await Deno.mkdir(tree.denoDir, { recursive: true });
        await Deno.mkdir(tree.bundleDir, { recursive: true });
        await Deno.writeTextFile(join(tree.bundleDir, "chunk.js"), "");
        return await failingStep();
      },
      restore: () =>
        restoreBuildState(
          tree.versionFile,
          original,
          tree.denoDir,
          tree.bundleDir,
        ),
    },
  };
}

Deno.test("runStampedBuild: a failing bundle step restores the stamp and removes both directories", async () => {
  await withBuildTree(async (tree) => {
    const { original, steps } = stampedBuildOver(
      tree,
      () => Promise.resolve(false),
    );
    await Deno.writeTextFile(tree.versionFile, original);
    assertEquals(await runStampedBuild(steps), false);
    assertEquals(await Deno.readTextFile(tree.versionFile), original);
    assertEquals(await exists(tree.denoDir), false);
    assertEquals(await exists(tree.bundleDir), false);
  });
});

Deno.test("runStampedBuild: a throwing compile step restores the stamp and removes both directories", async () => {
  await withBuildTree(async (tree) => {
    const { original, steps } = stampedBuildOver(
      tree,
      () => Promise.reject(new Error("compile failed")),
    );
    await Deno.writeTextFile(tree.versionFile, original);
    await assertRejects(() => runStampedBuild(steps), Error, "compile failed");
    assertEquals(await Deno.readTextFile(tree.versionFile), original);
    assertEquals(await exists(tree.denoDir), false);
    assertEquals(await exists(tree.bundleDir), false);
  });
});

Deno.test("npmExternals: collects npm import names across configs, sorted and de-duplicated", () => {
  assertEquals(
    npmExternals([
      {
        imports: {
          "zod": "npm:zod@^4.6.7",
          "@std/path": "jsr:@std/path@^1.1.4",
          "react/jsx-runtime": "npm:react@^19.2.5/jsx-runtime",
          "local": "./src/local.ts",
        },
        workspace: ["packages/a"],
      },
      { imports: { "zod": "npm:zod@^4.6.7", "cel-js": "npm:cel-js@7" } },
      {},
    ]),
    ["cel-js", "react/jsx-runtime", "zod"],
  );
});

Deno.test("npmExternals: treats every package.json dependency as external", () => {
  assertEquals(
    npmExternals([
      { imports: { "zod": "npm:zod@4" } },
      {
        dependencies: { "d3-force": "^3.0.0" },
        devDependencies: { "vite": "^6.0.0" },
        optionalDependencies: { "fsevents": "^2.3.3" },
        peerDependencies: { "react": "^19.0.0" },
      },
    ]),
    ["d3-force", "fsevents", "react", "vite", "zod"],
  );
});

Deno.test("npmExternals: ignores a package.json imports field that holds condition objects", () => {
  const pkg = {
    imports: { "#dep": { node: "dep-node", default: "./dep.js" } },
    dependencies: { "d3-force": "^3" },
  } as unknown as PackageJson;
  assertEquals(npmExternals([pkg]), ["d3-force"]);
});

Deno.test("readWorkspaceConfigs: reads deno.jsonc and package.json members and expands glob entries", async () => {
  const root = await Deno.makeTempDir({ prefix: "compile-workspace-" });
  try {
    const write = async (path: string, text: string) => {
      await Deno.mkdir(dirname(join(root, path)), { recursive: true });
      await Deno.writeTextFile(join(root, path), text);
    };
    await write(
      "deno.json",
      JSON.stringify({
        workspace: ["packages/*", "explicit"],
        imports: { "zod": "npm:zod@4" },
      }),
    );
    await write(
      "packages/a/deno.jsonc",
      '// comment\n{ "imports": { "ink": "npm:ink@6" } }',
    );
    await write(
      "packages/b/package.json",
      JSON.stringify({ dependencies: { "d3-force": "^3" } }),
    );
    await write(
      "explicit/deno.json",
      JSON.stringify({ imports: { "yaml": "npm:yaml@2" } }),
    );
    const { configs, paths } = await readWorkspaceConfigs(root);
    assertEquals(npmExternals(configs), ["d3-force", "ink", "yaml", "zod"]);
    assertEquals(paths.length, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readWorkspaceConfigs: refuses a root without a deno.json or deno.jsonc", async () => {
  const root = await Deno.makeTempDir({ prefix: "compile-workspace-" });
  try {
    await assertRejects(() => readWorkspaceConfigs(root), Error, "No deno.json");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("inlinedNpmPackages: names packages from the npm cache of any registry and from node_modules", () => {
  const home = resolve("home");
  const bundleDir = join(resolve("repo"), "build", "bundle");
  const npmCache = join(home, ".cache", "deno", "npm");
  const from = (first: string, ...rest: string[]) =>
    relative(bundleDir, join(first, ...rest));
  assertEquals(
    inlinedNpmPackages([
      from(resolve("repo"), "src", "cli", "mod.ts"),
      from(resolve("repo"), "src", "npm", "registry", "pkg", "x.ts"),
      from(home, ".cache", "deno", "remote", "https", "jsr.io", "@std", "a.ts"),
      from(npmCache, "registry.npmjs.org", "emojilib", "2.4.0", "index.js"),
      from(npmCache, "npm.example.com", "@scope", "pkg", "1.0.0", "a.js"),
      from(npmCache, "localhost_4873", "yaml", "2.9.0", "index.js"),
      from(
        resolve("repo"),
        "node_modules",
        ".deno",
        "zod@4.6.7",
        "node_modules",
        "zod",
        "index.js",
      ),
    ], { bundleDir, npmCache }),
    ["@scope/pkg", "emojilib", "yaml", "zod"],
  );
});

Deno.test("requireRepoSources: accepts maps whose sources resolve inside the repo", () => {
  const root = resolve("repo");
  const bundleDir = join(root, "build", "bundle");
  requireRepoSources(
    [relative(bundleDir, join(root, "src", "cli", "mod.ts"))],
    { bundleDir, root },
  );
});

Deno.test("requireRepoSources: refuses maps whose sources are URLs or specifiers", () => {
  const root = resolve("repo");
  const bundleDir = join(root, "build", "bundle");
  assertThrows(
    () =>
      requireRepoSources(
        [
          "npm:zod@4/index.js",
          "file:///repo/src/cli/mod.ts",
          relative(bundleDir, resolve("elsewhere", "a")),
        ],
        { bundleDir, root },
      ),
    Error,
    "inlined npm packages cannot run",
  );
  assertThrows(() => requireRepoSources([], { bundleDir, root }), Error);
});

Deno.test("requireNpmExternals: refuses an empty list and names the configs read", () => {
  assertThrows(
    () =>
      requireNpmExternals({
        configs: [{ imports: { "@std/path": "jsr:@std/path@1" } }],
        paths: ["/repo/deno.json"],
      }),
    Error,
    "/repo/deno.json",
  );
});

Deno.test("readWorkspaceConfigs: the repo's workspace configs yield the npm externals", async () => {
  const externals = requireNpmExternals(await readWorkspaceConfigs(repoRoot));
  for (const name of ["zod", "ink", "react/jsx-runtime", "d3-force"]) {
    assertEquals(externals.includes(name), true, `${name} is not external`);
  }
});

Deno.test("bundleArgs: bundles main.ts with code splitting, kept names and linked maps", () => {
  assertEquals(bundleArgs("out", ["ink", "zod"]), [
    "bundle",
    "--platform",
    "deno",
    "--format",
    "esm",
    "--code-splitting",
    "--keep-names",
    "--sourcemap=linked",
    "--outdir",
    "out",
    "--external=ink",
    "--external=zod",
    "main.ts",
  ]);
});

Deno.test("sourceMapIncludes: includes only the map files, in sorted order", () => {
  assertEquals(
    sourceMapIncludes("out", [
      "main.js",
      "main.js.map",
      "chunk-B.js.map",
      "chunk-B.js",
      "chunk-A.js.map",
    ]),
    [
      "--include",
      join("out", "chunk-A.js.map"),
      "--include",
      join("out", "chunk-B.js.map"),
      "--include",
      join("out", "main.js.map"),
    ],
  );
});

const UNBUNDLED_ARGS = [
  "compile",
  "--unstable-bundle",
  "--unstable-net",
  "--exclude-unused-npm",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  "--allow-net",
  "--allow-ffi",
  "--include",
  ".claude/skills",
  "--include",
  "resources/deno",
  "--include",
  "packages/dashboard/dist",
  "--exclude",
  "agent-constraints",
  "--exclude",
  ".agents",
  "--exclude",
  ".claude/skills/ddd",
  "--exclude",
  ".claude/skills/github-pr",
  "--exclude",
  ".claude/skills/jujutsu",
  "--exclude",
  ".claude/skills/issue-lifecycle",
  "--exclude",
  ".claude/skills/skill-creator",
  "--exclude",
  ".claude/skills/terminal-output",
  "--exclude",
  ".github",
  "--exclude",
  ".vault-test-vault",
  "--exclude",
  "design",
  "--exclude",
  "evals",
  "--exclude",
  "integration",
  "--exclude",
  "scripts",
  "--exclude",
  "verification",
  "--exclude",
  "workflows",
  "--target",
  "x86_64-unknown-linux-gnu",
  "--output",
  "dist/swamp",
  "main.ts",
];

Deno.test("compileArgs: the unbundled build compiles main.ts with the release flags", () => {
  assertEquals(
    compileArgs(
      { output: "dist/swamp", target: "x86_64-unknown-linux-gnu" },
      { entry: "main.ts", dashboardDistExists: true, extraIncludes: [] },
    ),
    UNBUNDLED_ARGS,
  );
});

Deno.test("compileArgs: leaves the dashboard out when it was not built, and omits --target", () => {
  const args = compileArgs(
    { output: "swamp" },
    { entry: "main.ts", dashboardDistExists: false, extraIncludes: [] },
  );
  assertEquals(args.includes("packages/dashboard/dist"), false);
  assertEquals(args.includes("--target"), false);
  assertEquals(args.slice(-3), ["--output", "swamp", "main.ts"]);
});

Deno.test("compileArgs: the bundled build compiles the bundle entry and includes its maps", () => {
  const entry = join(BUNDLE_DIR, "main.js");
  const mapInclude = ["--include", join(BUNDLE_DIR, "main.js.map")];
  const args = compileArgs(
    { output: "swamp" },
    { entry, dashboardDistExists: false, extraIncludes: mapInclude },
  );
  assertEquals(args.at(-1), entry);
  const at = args.indexOf(join(BUNDLE_DIR, "main.js.map"));
  assertEquals(args[at - 1], "--include");
  // no --exclude may cover the bundle output
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--exclude") {
      assertEquals(BUNDLE_DIR.startsWith(args[i + 1]), false, args[i + 1]);
    }
  }
});
