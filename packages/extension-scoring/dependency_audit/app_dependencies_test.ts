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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appDependencySpecifiers,
  parseBunLockText,
  PLATFORM_PACKAGES,
  shippedLockKeys,
} from "./app_dependencies.ts";

const SHA = "sha512-Aup7aUOfpbAUg2ROOJN6Iw5f9DMBlzu0mIkm/malLQFN==";

// the shape bun writes: a root workspace, then `key: [id, registry, meta, integrity]`
function lockWith(packages: Record<string, string>, extra = ""): string {
  const rows = Object.entries(packages).map(([key, row]) =>
    `    "${key}": ${row},\n`
  ).join("\n");
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "swamp-app",
      "devDependencies": {
        "react": "19.3.1",
        "vite": "^6.4.6",
      },
    },
  },${extra}
  "packages": {
${rows}  }
}
`;
}

const PACKAGES: Record<string, string> = {
  "@babel/core":
    `["@babel/core@7.29.13", "", { "dependencies": { "semver": "^6.3.1" } }, "${SHA}"]`,
  "@esbuild/linux-x64":
    `["@esbuild/linux-x64@0.25.12", "", { "os": "linux", "cpu": "x64" }, "${SHA}"]`,
  "react": `["react@19.3.1", "", {}, "${SHA}"]`,
  "semver":
    `["semver@6.3.1", "", { "bin": { "semver": "bin/semver.js" } }, "${SHA}"]`,
  "vite":
    `["vite@6.4.6", "", { "dependencies": { "esbuild": "^0.25.0" }, "optionalDependencies": { "fsevents": "~2.3.3" } }, "${SHA}"]`,
  "@types/node/undici-types": `["undici-types@8.9.0", "", {}, "${SHA}"]`,
  "@tailwindcss/oxide-wasm32-wasi/tslib":
    `["tslib@2.9.1", "", { "bundled": true }, "${SHA}"]`,
  "vite/semver": `["semver@7.7.2", "", {}, "${SHA}"]`,
};

const LOCK = lockWith(PACKAGES);

function read(packageJson: unknown, bunLock: string | null = LOCK) {
  return appDependencySpecifiers(
    {
      packageJson: packageJson === null ? null : JSON.stringify(packageJson),
      bunLock,
      otherLockfiles: [],
    },
    "cost",
    "apps/cost/package.json",
    "apps/cost/bun.lock",
  );
}

function all(deps: ReturnType<typeof read>) {
  return [...deps.shipped, ...deps.buildOnly];
}

function problemsOf(packageJson: unknown, bunLock: string | null = LOCK) {
  return read(packageJson, bunLock).problems;
}

const APP = { devDependencies: { react: "19.3.1", vite: "^6.4.6" } };

Deno.test("parseBunLockText: drops trailing commas but not commas inside strings", () => {
  assertEquals(parseBunLockText('{ "a": ["x, ]", ], }'), { a: ["x, ]"] });
});

Deno.test("appDependencySpecifiers: every package in the lock is checked at its locked version", () => {
  const deps = read(APP);
  const specifiers = all(deps);
  assertEquals(deps.problems, []);
  assertEquals(
    specifiers.map((
      s,
    ) => [s.name, s.version, s.sourceFile, s.bundled?.version]),
    [
      ["react", "19.3.1", "apps/cost/package.json", "19.3.1"],
      ["vite", "^6.4.6", "apps/cost/package.json", "6.4.6"],
      ["@babel/core", "7.29.13", "apps/cost/bun.lock", "7.29.13"],
      ["@esbuild/linux-x64", "0.25.12", "apps/cost/bun.lock", "0.25.12"],
      ["semver", "6.3.1", "apps/cost/bun.lock", "6.3.1"],
      ["undici-types", "8.9.0", "apps/cost/bun.lock", "8.9.0"],
      ["tslib", "2.9.1", "apps/cost/bun.lock", "2.9.1"],
      ["semver", "7.7.2", "apps/cost/bun.lock", "7.7.2"],
    ],
  );
  for (const spec of specifiers) {
    assertEquals(spec.registry, "npm");
    assertEquals(spec.bundled?.from, "lockfile");
    assertEquals(spec.bundled?.locked, true);
  }
});

Deno.test("appDependencySpecifiers: a package the lock lists twice is audited once", () => {
  const deps = read(
    APP,
    lockWith({
      ...PACKAGES,
      "@babel/core/semver": `["semver@6.3.1", "", {}, "${SHA}"]`,
    }),
  );
  assertEquals(deps.problems, []);
  assertEquals(
    all(deps).filter((s) => s.name === "semver").map((s) => s.version),
    ["6.3.1", "7.7.2"],
  );
});

Deno.test("appDependencySpecifiers: an app with no packages needs no lock", () => {
  assertEquals(read({}, null), { shipped: [], buildOnly: [], problems: [] });
});

Deno.test("appDependencySpecifiers: what cannot be audited is a problem", () => {
  assertStringIncludes(problemsOf(null)[0], "no package.json");
  assertStringIncludes(
    problemsOf({ dependencies: { react: "^19" } }, null)[0],
    "no bun.lock",
  );
  assertStringIncludes(
    problemsOf({ dependencies: { react: "^19" } }, "{ not json")[0],
    "cannot be read",
  );
  assertStringIncludes(
    problemsOf({ dependencies: { left: "github:a/left" } })[0],
    "not an npm registry version",
  );
  assertStringIncludes(
    problemsOf({ dependencies: { react: "^20" } })[0],
    "outside ^20",
  );
  assertStringIncludes(
    problemsOf({ dependencies: { missing: "^1" } })[0],
    "does not pin missing",
  );
});

Deno.test("appDependencySpecifiers: a transitive package from outside the npm registry is refused", () => {
  const sources = {
    git:
      `["left@git+https://github.com/someone/left.git#abc123", { "dependencies": {} }, "abc123"]`,
    github: `["left@github:someone/left#abc123", {}, "someone-left-abc123"]`,
    tarball: `["left@https://evil.example/left-1.0.0.tgz", {}]`,
    file: `["left@file:../left", {}]`,
    link: `["left@link:left", {}]`,
    workspace: `["left@workspace:packages/left"]`,
  };
  for (const [kind, row] of Object.entries(sources)) {
    const problems = problemsOf(APP, lockWith({ ...PACKAGES, left: row }));
    assertEquals(problems.length, 1, kind);
    assertStringIncludes(problems[0], "takes left from left@");
    assertStringIncludes(problems[0], "not the npm registry");
  }
});

Deno.test("appDependencySpecifiers: a registry version fetched from another registry is refused", () => {
  const problems = problemsOf(
    APP,
    lockWith({
      ...PACKAGES,
      react:
        `["react@19.3.1", "https://evil.example/react-19.3.1.tgz", {}, "${SHA}"]`,
    }),
  );
  assertEquals(problems, [
    "App cost's bun.lock takes react@19.3.1 from https://evil.example/react-19.3.1.tgz, not the npm registry, so it cannot be audited. Remove the registry setting and run bun install.",
  ]);
});

Deno.test("appDependencySpecifiers: a lock entry without an integrity hash is refused", () => {
  for (
    const row of [`["semver@6.3.1", "", {}]`, `["semver@6.3.1", "", {}, ""]`]
  ) {
    assertEquals(problemsOf(APP, lockWith({ ...PACKAGES, semver: row })), [
      "App cost's bun.lock has no integrity hash for semver@6.3.1. Run bun install.",
    ]);
  }
});

Deno.test("appDependencySpecifiers: fields that change what bun installs are refused", () => {
  for (
    const field of [
      "overrides",
      "resolutions",
      "trustedDependencies",
      "patchedDependencies",
      "workspaces",
    ]
  ) {
    const problems = problemsOf({ ...APP, [field]: {} });
    assertEquals(problems.length, 1, field);
    assertStringIncludes(problems[0], `package.json sets ${field}, which`);
  }
  for (
    const field of ["overrides", "trustedDependencies", "patchedDependencies"]
  ) {
    const problems = problemsOf(
      APP,
      lockWith(PACKAGES, `\n  "${field}": { "react": "19.3.1" },`),
    );
    assertEquals(problems.length, 1, field);
    assertStringIncludes(problems[0], `bun.lock records ${field}, which`);
  }
});

Deno.test("appDependencySpecifiers: a lock with other workspaces is refused", () => {
  const lock = LOCK.replace(
    `"workspaces": {`,
    `"workspaces": {\n    "packages/left": { "name": "left" },`,
  );
  assertStringIncludes(problemsOf(APP, lock)[0], "workspaces besides the app");
});

Deno.test("appDependencySpecifiers: one package declared at two specs is refused", () => {
  assertEquals(
    problemsOf({
      dependencies: { react: "19.3.1" },
      devDependencies: { react: "^19.0.0" },
    }),
    [
      "App cost's package.json declares react as 19.3.1 in dependencies and ^19.0.0 in devDependencies. Declare it once.",
    ],
  );
  assertEquals(
    problemsOf({
      dependencies: { react: "19.3.1" },
      devDependencies: { react: "19.3.1" },
    }),
    [],
  );
});

Deno.test("appDependencySpecifiers: optional and peer packages are audited when the lock holds them", () => {
  const deps = read({
    optionalDependencies: { fsevents: "~2.3.3" },
    peerDependencies: { react: "^19.0.0" },
  });
  const specifiers = all(deps);
  assertEquals(deps.problems, []);
  assertEquals(
    specifiers.find((s) => s.name === "react")?.sourceFile,
    "apps/cost/package.json",
  );
  assert(!specifiers.some((s) => s.name === "fsevents"));
  assertStringIncludes(
    problemsOf({ optionalDependencies: { left: "github:someone/left" } })[0],
    "not an npm registry version",
  );
});

// left -> mid -> (nested leaf@2, peer-x, opt-x); devtool -> top-level leaf@1;
// react is the platform's and needs scheduler; a and b need each other
const CLOSURE: Record<string, string> = {
  "left":
    `["left@1.0.0", "", { "dependencies": { "mid": "^1.0.0" } }, "${SHA}"]`,
  "mid":
    `["mid@1.0.0", "", { "dependencies": { "leaf": "^2.0.0" }, "optionalDependencies": { "opt-x": "1.0.0" }, "peerDependencies": { "peer-x": "*" } }, "${SHA}"]`,
  "mid/leaf": `["leaf@2.0.0", "", {}, "${SHA}"]`,
  "leaf": `["leaf@1.0.0", "", {}, "${SHA}"]`,
  "peer-x": `["peer-x@1.0.0", "", {}, "${SHA}"]`,
  "opt-x": `["opt-x@1.0.0", "", { "os": "darwin" }, "${SHA}"]`,
  "devtool":
    `["devtool@1.0.0", "", { "dependencies": { "leaf": "^1.0.0" } }, "${SHA}"]`,
  "react":
    `["react@19.3.1", "", { "dependencies": { "scheduler": "^0.27.0" } }, "${SHA}"]`,
  "scheduler": `["scheduler@0.27.0", "", {}, "${SHA}"]`,
  "a": `["a@1.0.0", "", { "dependencies": { "b": "1.0.0" } }, "${SHA}"]`,
  "b": `["b@1.0.0", "", { "dependencies": { "a": "1.0.0" } }, "${SHA}"]`,
  "@s/p": `["@s/p@1.0.0", "", { "dependencies": { "@s/q": "^1" } }, "${SHA}"]`,
  "@s/p/@s/q": `["@s/q@1.5.0", "", {}, "${SHA}"]`,
  "@s/q": `["@s/q@1.0.0", "", {}, "${SHA}"]`,
};

function ids(
  specs: readonly { name: string; bundled?: { version: string } }[],
) {
  return specs.map((s) => `${s.name}@${s.bundled?.version}`).sort();
}

Deno.test("appDependencySpecifiers: only what runtime dependencies reach is audited; build tools get the static checks", () => {
  const deps = read(
    {
      dependencies: { left: "^1.0.0", react: "19.3.1" },
      devDependencies: { devtool: "^1.0.0" },
    },
    lockWith(CLOSURE),
  );
  assertEquals(deps.problems, []);
  assertEquals(ids(deps.shipped), [
    "leaf@2.0.0",
    "left@1.0.0",
    "mid@1.0.0",
    "opt-x@1.0.0",
    "peer-x@1.0.0",
  ]);
  assertEquals(ids(deps.buildOnly), [
    "@s/p@1.0.0",
    "@s/q@1.0.0",
    "@s/q@1.5.0",
    "a@1.0.0",
    "b@1.0.0",
    "devtool@1.0.0",
    "leaf@1.0.0",
    "react@19.3.1",
    "scheduler@0.27.0",
  ]);
});

Deno.test("appDependencySpecifiers: an app whose packages are all devDependencies ships none of them", () => {
  const deps = read(APP);
  assertEquals(deps.shipped, []);
  assertEquals(deps.buildOnly.length, Object.keys(PACKAGES).length);
});

Deno.test("appDependencySpecifiers: a build-only package still fails the static checks", () => {
  const problems = problemsOf(
    { dependencies: { left: "^1.0.0" }, devDependencies: { devtool: "^1" } },
    lockWith({ ...CLOSURE, devtool: `["devtool@1.0.0", "", {}]` }),
  );
  assertEquals(problems, [
    "App cost's bun.lock has no integrity hash for devtool@1.0.0. Run bun install.",
  ]);
});

Deno.test("shippedLockKeys: a cycle of runtime dependencies terminates with both", () => {
  const packages = parseBunLockText(lockWith(CLOSURE)) as {
    packages: Record<string, unknown>;
  };
  assertEquals(
    [...shippedLockKeys({ dependencies: { a: "1.0.0" } }, packages.packages)]
      .sort(),
    ["a", "b"],
  );
});

Deno.test("shippedLockKeys: a nested scoped package resolves under its scoped parent first", () => {
  const { packages } = parseBunLockText(lockWith(CLOSURE)) as {
    packages: Record<string, unknown>;
  };
  assertEquals(
    [...shippedLockKeys({ dependencies: { "@s/p": "1.0.0" } }, packages)]
      .sort(),
    ["@s/p", "@s/p/@s/q"],
  );
});

Deno.test("shippedLockKeys: a platform package is external, but what it needs ships when another package needs it", () => {
  const { packages } = parseBunLockText(lockWith({
    ...CLOSURE,
    "chart":
      `["chart@1.0.0", "", { "dependencies": { "d3-scale": "4", "scheduler": "*" } }, "${SHA}"]`,
    "d3-scale": `["d3-scale@4.0.3", "", {}, "${SHA}"]`,
  })) as { packages: Record<string, unknown> };
  assertEquals(
    [
      ...shippedLockKeys(
        { dependencies: { react: "19.3.1", chart: "1.0.0" } },
        packages,
      ),
    ].sort(),
    ["chart", "scheduler"],
  );
});

Deno.test("shippedLockKeys: a dependency the lock lacks is skipped, not invented", () => {
  assertEquals(
    [...shippedLockKeys({ dependencies: { gone: "1" } }, {})],
    [],
  );
  assertEquals([...shippedLockKeys(null, {})], []);
});

Deno.test("PLATFORM_PACKAGES: is the packages of every module the app SDK serves", async () => {
  const source = await Deno.readTextFile(
    new URL("../../app-sdk/vite.ts", import.meta.url),
  );
  const block = source.slice(source.indexOf("PLATFORM_MODULES"));
  const table = block.slice(block.indexOf("{"), block.indexOf("};"));
  const packages = [...table.matchAll(/^\s*"([^"]+)":/gm)].map(([, id]) =>
    id.split("/").slice(0, id.startsWith("@") ? 2 : 1).join("/")
  );
  assert(packages.length > 0);
  assertEquals(new Set(packages), new Set(PLATFORM_PACKAGES));
});
