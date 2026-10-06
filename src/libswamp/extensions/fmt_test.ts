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
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  extensionFmt,
  type ExtensionFmtDeps,
  type ExtensionFmtEvent,
} from "./fmt.ts";

function makeDeps(overrides?: Partial<ExtensionFmtDeps>): ExtensionFmtDeps {
  return {
    checkQuality: overrides?.checkQuality ??
      (() => Promise.resolve({ passed: true, issues: [] })),
    runFmt: overrides?.runFmt ?? (() => Promise.resolve("")),
    runLint: overrides?.runLint ?? (() => Promise.resolve("")),
  };
}

Deno.test("extensionFmt: no files yields no_files event", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, { tsFiles: [], check: false }),
  );

  assertEquals(events, [{ kind: "no_files" }]);
});

Deno.test("extensionFmt: check mode passes", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    checkQuality: () => Promise.resolve({ passed: true, issues: [] }),
  });

  const events = await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, { tsFiles: ["a.ts"], check: true }),
  );

  assertEquals(events, [
    {
      kind: "completed",
      data: { mode: "check", passed: true, issues: [] },
    },
  ]);
});

Deno.test("extensionFmt: check mode fails", async () => {
  const ctx = createLibSwampContext();
  const issues = [{ check: "fmt" as const, output: "bad formatting" }];
  const deps = makeDeps({
    checkQuality: () => Promise.resolve({ passed: false, issues }),
  });

  const events = await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, { tsFiles: ["a.ts"], check: true }),
  );

  assertEquals(events, [
    {
      kind: "completed",
      data: { mode: "check", passed: false, issues },
    },
  ]);
});

Deno.test("extensionFmt: fix mode succeeds with no remaining issues", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    runFmt: () => Promise.resolve("formatted"),
    runLint: () => Promise.resolve("linted"),
    checkQuality: () => Promise.resolve({ passed: true, issues: [] }),
  });

  const events = await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, { tsFiles: ["a.ts", "b.ts"], check: false }),
  );

  assertEquals(events, [
    {
      kind: "completed",
      data: {
        mode: "fix",
        fileCount: 2,
        fmtOutput: "formatted",
        lintOutput: "linted",
        remainingIssues: [],
        passed: true,
      },
    },
  ]);
});

Deno.test("extensionFmt: fix mode with remaining issues", async () => {
  const ctx = createLibSwampContext();
  const remainingIssues = [
    { check: "lint" as const, output: "unfixable lint error" },
  ];
  const deps = makeDeps({
    runFmt: () => Promise.resolve(""),
    runLint: () => Promise.resolve(""),
    checkQuality: () =>
      Promise.resolve({ passed: false, issues: remainingIssues }),
  });

  const events = await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, { tsFiles: ["a.ts"], check: false }),
  );

  assertEquals(events, [
    {
      kind: "completed",
      data: {
        mode: "fix",
        fileCount: 1,
        fmtOutput: "",
        lintOutput: "",
        remainingIssues,
        passed: false,
      },
    },
  ]);
});

Deno.test("extensionFmt: check mode checks under the project config", async () => {
  const ctx = createLibSwampContext();
  const seen: Array<string | undefined> = [];
  const deps = makeDeps({
    checkQuality: (_files, denoConfigPath) => {
      seen.push(denoConfigPath);
      return Promise.resolve({ passed: true, issues: [] });
    },
  });

  await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, {
      tsFiles: ["a.ts"],
      check: true,
      denoConfigPath: "/ext/deno.json",
    }),
  );

  assertEquals(seen, ["/ext/deno.json"]);
});

Deno.test("extensionFmt: fix mode formats, lints and re-checks under the project config", async () => {
  const ctx = createLibSwampContext();
  const seen: string[] = [];
  const record = (step: string, denoConfigPath?: string) =>
    seen.push(`${step}:${denoConfigPath ?? "none"}`);
  const deps = makeDeps({
    runFmt: (_files, denoConfigPath) => {
      record("fmt", denoConfigPath);
      return Promise.resolve("");
    },
    runLint: (_files, denoConfigPath) => {
      record("lint", denoConfigPath);
      return Promise.resolve("");
    },
    checkQuality: (_files, denoConfigPath) => {
      record("check", denoConfigPath);
      return Promise.resolve({ passed: true, issues: [] });
    },
  });

  await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, {
      tsFiles: ["a.ts"],
      check: false,
      denoConfigPath: "/ext/deno.json",
    }),
  );

  assertEquals(seen, [
    "fmt:/ext/deno.json",
    "lint:/ext/deno.json",
    "check:/ext/deno.json",
  ]);
});

Deno.test("extensionFmt: without a project config every step uses the defaults", async () => {
  const ctx = createLibSwampContext();
  const seen: Array<string | undefined> = [];
  const deps = makeDeps({
    runFmt: (_files, denoConfigPath) => {
      seen.push(denoConfigPath);
      return Promise.resolve("");
    },
    runLint: (_files, denoConfigPath) => {
      seen.push(denoConfigPath);
      return Promise.resolve("");
    },
    checkQuality: (_files, denoConfigPath) => {
      seen.push(denoConfigPath);
      return Promise.resolve({ passed: true, issues: [] });
    },
  });

  await collect<ExtensionFmtEvent>(
    extensionFmt(ctx, deps, { tsFiles: ["a.ts"], check: false }),
  );

  assertEquals(seen, [undefined, undefined, undefined]);
});
