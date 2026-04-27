// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import type { ReporterContext } from "../../domain/extensions/reporter_context.ts";
import {
  dispatchRepositoryReport,
  type ExtensionTarget,
  resolveExtensionTarget,
} from "./extension_report_dispatcher.ts";
import type {
  GhCliRunner,
  GhRunResult,
} from "../../infrastructure/process/gh_cli.ts";
import { parseRepositoryUrl } from "../../domain/extensions/repository_url.ts";

const MANIFEST_NO_REPO = `manifestVersion: 1
name: "@adam/cfgmgmt"
version: "2026.04.22.1"
models:
  - foo.yaml
`;

const MANIFEST_GH = `manifestVersion: 1
name: "@adam/cfgmgmt"
version: "2026.04.22.1"
repository: "https://github.com/adam/cfgmgmt"
models:
  - foo.yaml
`;

const MANIFEST_SWAMP = `manifestVersion: 1
name: "@swamp/aws"
version: "2026.04.22.1"
models:
  - foo.yaml
`;

const SAMPLE_CONTEXT: ReporterContext = {
  extensionName: "@adam/cfgmgmt",
  extensionVersion: "2026.04.22.1",
  swampVersion: "20260422.000000.0-sha.abc",
  os: "darwin",
  arch: "aarch64",
  shell: "/bin/zsh",
  denoVersion: "1.45.0",
};

async function makeRepo(
  extensionName: string,
  manifestContent: string | null,
  opts: { includeSources?: boolean; lockedVersion?: string } = {},
): Promise<string> {
  const repo = await Deno.makeTempDir({ prefix: "swamp_dispatch_" });
  // Minimal repo marker (empty file is fine).
  await Deno.writeTextFile(join(repo, ".swamp.yaml"), "repo: {}\n");
  await Deno.mkdir(join(repo, ".swamp"), { recursive: true });

  if (manifestContent !== null) {
    const extDir = join(repo, ".swamp", "pulled-extensions", extensionName);
    await Deno.mkdir(extDir, { recursive: true });
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      manifestContent,
    );
    // Write a minimal lockfile so version lookups succeed.
    const modelsDir = join(repo, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const lockfile = join(modelsDir, "upstream_extensions.json");
    const entry = {
      [extensionName]: {
        version: opts.lockedVersion ?? "2026.04.22.1",
        pulledAt: new Date().toISOString(),
      },
    };
    await Deno.writeTextFile(lockfile, JSON.stringify(entry));
  }

  if (opts.includeSources) {
    await Deno.writeTextFile(
      join(repo, ".swamp-sources.yaml"),
      "sources:\n  - path: ./local-sources\n    kinds: [models]\n",
    );
  }

  return repo;
}

function fakeRunner(
  handler: (args: string[], stdin?: string) => GhRunResult,
): GhCliRunner {
  return {
    run(args, opts) {
      return Promise.resolve(handler(args, opts?.stdin));
    },
  };
}

// ---- resolveExtensionTarget ----

Deno.test("resolveExtensionTarget: not-pulled refusal when manifest is missing", async () => {
  const repo = await makeRepo("@adam/cfgmgmt", null);
  try {
    const t = await resolveExtensionTarget(repo, "@adam/cfgmgmt");
    assertEquals(t.kind, "refused");
    if (t.kind === "refused") {
      assertEquals(t.reason, "not-pulled");
      assertStringIncludes(t.guidance, "swamp extension pull @adam/cfgmgmt");
    }
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resolveExtensionTarget: not-pulled mentions sources when .swamp-sources.yaml present", async () => {
  const repo = await makeRepo("@adam/cfgmgmt", null, { includeSources: true });
  try {
    const t = await resolveExtensionTarget(repo, "@adam/cfgmgmt");
    if (t.kind !== "refused") throw new Error("expected refusal");
    assertStringIncludes(t.guidance, "locally sourced");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resolveExtensionTarget: no-repository refusal when manifest has no repository", async () => {
  const repo = await makeRepo("@adam/cfgmgmt", MANIFEST_NO_REPO);
  try {
    const t = await resolveExtensionTarget(repo, "@adam/cfgmgmt");
    if (t.kind !== "refused") throw new Error("expected refusal");
    assertEquals(t.reason, "no-repository");
    assertStringIncludes(t.guidance, "does not declare a repository");
    assertStringIncludes(
      t.guidance,
      "swamp-club.com/extensions/%40adam%2Fcfgmgmt",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resolveExtensionTarget: swamp-lab target for @swamp collective", async () => {
  const repo = await makeRepo("@swamp/aws", MANIFEST_SWAMP);
  try {
    const t = await resolveExtensionTarget(repo, "@swamp/aws");
    assertEquals(t.kind, "swamp-lab");
    if (t.kind === "swamp-lab") {
      assertEquals(t.extensionName, "@swamp/aws");
      assertEquals(t.extensionVersion, "2026.04.22.1");
    }
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resolveExtensionTarget: repository target for third-party with manifest.repository", async () => {
  const repo = await makeRepo("@adam/cfgmgmt", MANIFEST_GH);
  try {
    const t = await resolveExtensionTarget(repo, "@adam/cfgmgmt");
    assertEquals(t.kind, "repository");
    if (t.kind === "repository") {
      assertEquals(t.repositoryUrl, "https://github.com/adam/cfgmgmt");
      assertEquals(t.parsed.provider, "github");
      assertEquals(t.parsed.ownerRepo, "adam/cfgmgmt");
    }
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resolveExtensionTarget: rejects malformed extension names early", async () => {
  const repo = await Deno.makeTempDir({ prefix: "swamp_dispatch_" });
  try {
    await assertRejects(
      () => resolveExtensionTarget(repo, "not-a-scoped-name"),
      UserError,
      "Invalid extension name",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

// ---- dispatchRepositoryReport: bug/feature branches ----

function makeRepoTarget(
  repositoryUrl = "https://github.com/adam/cfgmgmt",
): Extract<ExtensionTarget, { kind: "repository" }> {
  return {
    kind: "repository",
    extensionName: "@adam/cfgmgmt",
    extensionVersion: "2026.04.22.1",
    repositoryUrl,
    parsed: parseRepositoryUrl(repositoryUrl),
  };
}

Deno.test("dispatchRepositoryReport: bug + gh available → gh issue create", async () => {
  const calls: string[][] = [];
  const runner = fakeRunner((args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      return {
        exitCode: 0,
        stdout: "https://github.com/adam/cfgmgmt/issues/42\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  });

  const result = await dispatchRepositoryReport(
    makeRepoTarget(),
    {
      type: "bug",
      title: "Boom",
      body: "body",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "log",
    },
    {
      ghRunner: runner,
      env: { get: () => "gh_x" },
      openBrowser: () => Promise.resolve(),
      writeLog: () => {},
    },
  );

  assertEquals(result.kind, "handoff");
  if (result.kind === "handoff") {
    assertEquals(result.method, "gh");
    assertEquals(result.variant, "issue");
    assertEquals(result.number, 42);
    assertStringIncludes(result.preparedBody, "Upstream repository:");
    assertStringIncludes(result.preparedBody, "## Environment");
  }
});

Deno.test("dispatchRepositoryReport: bug + gh unavailable → browser handoff", async () => {
  const openBrowserCalls: string[] = [];
  const runner = fakeRunner(() => ({
    exitCode: 1,
    stdout: "",
    stderr: "not logged in",
  }));

  const result = await dispatchRepositoryReport(
    makeRepoTarget(),
    {
      type: "bug",
      title: "Boom",
      body: "body",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "log",
    },
    {
      ghRunner: runner,
      env: { get: () => undefined },
      openBrowser: (url) => {
        openBrowserCalls.push(url);
        return Promise.resolve();
      },
      writeLog: () => {},
    },
  );

  assertEquals(result.kind, "handoff");
  if (result.kind === "handoff") {
    assertEquals(result.method, "browser");
    assertEquals(result.variant, "issue");
  }
  assertEquals(openBrowserCalls.length, 1);
  assertStringIncludes(
    openBrowserCalls[0],
    "github.com/adam/cfgmgmt/issues/new",
  );
});

Deno.test("dispatchRepositoryReport: gitlab provider routes to gitlab new-issue URL", async () => {
  const openBrowserCalls: string[] = [];
  const result = await dispatchRepositoryReport(
    makeRepoTarget("https://gitlab.com/group/proj"),
    {
      type: "bug",
      title: "t",
      body: "b",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "log",
    },
    {
      openBrowser: (url) => {
        openBrowserCalls.push(url);
        return Promise.resolve();
      },
      writeLog: () => {},
    },
  );
  assertEquals(result.kind, "handoff");
  assertStringIncludes(
    openBrowserCalls[0],
    "gitlab.com/group/proj/-/issues/new",
  );
});

Deno.test("dispatchRepositoryReport: other provider opens repo root", async () => {
  const openBrowserCalls: string[] = [];
  const result = await dispatchRepositoryReport(
    makeRepoTarget("https://bitbucket.org/group/proj"),
    {
      type: "bug",
      title: "t",
      body: "b",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "log",
    },
    {
      openBrowser: (url) => {
        openBrowserCalls.push(url);
        return Promise.resolve();
      },
      writeLog: () => {},
    },
  );
  assertEquals(result.kind, "handoff");
  assertEquals(openBrowserCalls[0], "https://bitbucket.org/group/proj");
});

Deno.test("dispatchRepositoryReport: log mode prints prepared title/body to writeLog", async () => {
  const logs: string[] = [];
  await dispatchRepositoryReport(
    makeRepoTarget(),
    {
      type: "bug",
      title: "T",
      body: "B",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "log",
    },
    {
      env: { get: () => undefined },
      ghRunner: fakeRunner(() => ({
        exitCode: 1,
        stdout: "",
        stderr: "not logged in",
      })),
      openBrowser: () => Promise.resolve(),
      writeLog: (text) => logs.push(text),
    },
  );
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "Title: T");
  assertStringIncludes(logs[0], "## Environment");
});

Deno.test("dispatchRepositoryReport: json mode does NOT print to writeLog", async () => {
  const logs: string[] = [];
  await dispatchRepositoryReport(
    makeRepoTarget(),
    {
      type: "bug",
      title: "T",
      body: "B",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "json",
    },
    {
      env: { get: () => undefined },
      ghRunner: fakeRunner(() => ({
        exitCode: 1,
        stdout: "",
        stderr: "not logged in",
      })),
      openBrowser: () => Promise.resolve(),
      writeLog: (text) => logs.push(text),
    },
  );
  assertEquals(logs.length, 0);
});

// ---- dispatchRepositoryReport: security branch (table-driven) ----

type SecurityCase = {
  name: string;
  ghAvailable: boolean;
  pvr: boolean | null | "gh-unavailable";
  expectedKind: "handoff" | "refused";
  expectedVariant?: "advisory" | "issue";
  expectedRefusalReason?: "pvr-disabled";
  assertFallback?: boolean;
  assertPvrCheckFailed?: boolean;
  assertPvrCheckSkipped?: boolean;
};

const SECURITY_CASES: SecurityCase[] = [
  {
    name: "PVR enabled + gh available → advisory handoff",
    ghAvailable: true,
    pvr: true,
    expectedKind: "handoff",
    expectedVariant: "advisory",
    assertFallback: true,
  },
  {
    name: "PVR disabled + gh available → REFUSAL (never public issue)",
    ghAvailable: true,
    pvr: false,
    expectedKind: "refused",
    expectedRefusalReason: "pvr-disabled",
  },
  {
    name:
      "PVR check failed + gh available → advisory handoff with checkFailed flag",
    ghAvailable: true,
    pvr: null,
    expectedKind: "handoff",
    expectedVariant: "advisory",
    assertFallback: true,
    assertPvrCheckFailed: true,
  },
  {
    name: "gh unavailable → advisory handoff with checkSkipped flag",
    ghAvailable: false,
    pvr: "gh-unavailable",
    expectedKind: "handoff",
    expectedVariant: "advisory",
    assertFallback: true,
    assertPvrCheckSkipped: true,
  },
];

for (const tc of SECURITY_CASES) {
  Deno.test(`dispatchRepositoryReport: security (github) — ${tc.name}`, async () => {
    const createIssueCalls: string[][] = [];
    const runner = fakeRunner((args) => {
      if (!tc.ghAvailable) {
        return { exitCode: -1, stdout: "", stderr: "", spawnFailed: true };
      }
      if (args[0] === "auth" && args[1] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "api") {
        if (tc.pvr === null) {
          return { exitCode: 1, stdout: "", stderr: "HTTP 500" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ enabled: tc.pvr === true }),
          stderr: "",
        };
      }
      if (args[0] === "issue" && args[1] === "create") {
        createIssueCalls.push(args);
        return {
          exitCode: 0,
          stdout: "https://github.com/a/b/issues/1\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await dispatchRepositoryReport(
      makeRepoTarget(),
      {
        type: "security",
        title: "vuln",
        body: "b",
        reporterContext: SAMPLE_CONTEXT,
        outputMode: "log",
      },
      {
        ghRunner: runner,
        env: { get: () => undefined },
        openBrowser: () => Promise.resolve(),
        writeLog: () => {},
      },
    );

    assertEquals(result.kind, tc.expectedKind);
    // SECURITY INVARIANT: no public issue should ever be created on the
    // security path. createIssueCalls MUST be empty across every case.
    assertEquals(
      createIssueCalls.length,
      0,
      "PVR-aware security path must never call gh issue create",
    );

    if (result.kind === "handoff") {
      assertEquals(result.variant, tc.expectedVariant);
      if (tc.assertFallback) {
        assert(
          typeof result.fallbackIssueUrl === "string",
          "expected fallbackIssueUrl to be populated",
        );
      }
      if (tc.assertPvrCheckFailed) {
        assertEquals(result.pvrCheckFailed, true);
      }
      if (tc.assertPvrCheckSkipped) {
        assertEquals(result.pvrCheckSkipped, true);
      }
    }
    if (result.kind === "refused") {
      assertEquals(result.reason, tc.expectedRefusalReason);
      assertStringIncludes(result.guidance, "For reporters:");
      assertStringIncludes(result.guidance, "For publishers:");
      assertStringIncludes(
        result.guidance,
        "settings/security_analysis",
      );
    }
  });
}

Deno.test("dispatchRepositoryReport: PVR disabled never files a public issue (invariant)", async () => {
  // Belt-and-suspenders test — asserts the security guardrail explicitly.
  const createIssueCalls: string[][] = [];
  const runner = fakeRunner((args) => {
    if (args[0] === "auth") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api") {
      return { exitCode: 0, stdout: '{"enabled":false}', stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "create") {
      createIssueCalls.push(args);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });

  const result = await dispatchRepositoryReport(
    makeRepoTarget(),
    {
      type: "security",
      title: "vuln",
      body: "b",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "log",
    },
    {
      ghRunner: runner,
      env: { get: () => undefined },
      openBrowser: () => Promise.resolve(),
      writeLog: () => {},
    },
  );

  assertEquals(result.kind, "refused");
  assertEquals(createIssueCalls.length, 0);
});

Deno.test("dispatchRepositoryReport: security on gitlab provider surfaces confidential warning", async () => {
  const openBrowserCalls: string[] = [];
  const result = await dispatchRepositoryReport(
    makeRepoTarget("https://gitlab.com/group/proj"),
    {
      type: "security",
      title: "vuln",
      body: "b",
      reporterContext: SAMPLE_CONTEXT,
      outputMode: "log",
    },
    {
      openBrowser: (url) => {
        openBrowserCalls.push(url);
        return Promise.resolve();
      },
      writeLog: () => {},
    },
  );
  assertEquals(result.kind, "handoff");
  if (result.kind === "handoff") {
    assertStringIncludes(result.nonGithubWarning ?? "", "confidential");
  }
});
