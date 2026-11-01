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
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { parseRepositoryUrl } from "../../domain/extensions/repository_url.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { GhCliRunner } from "../../infrastructure/process/gh_cli.ts";
import type { CommandContext } from "../context.ts";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import type { RedactionConfirmDeps } from "./issue_redaction_confirm.ts";
import {
  buildMailtoUrl,
  dispatchExtensionRepositoryReport,
  prefillTitle,
  requireNonBlank,
  resolveDestination,
  resolveExtensionOrRefuse,
  resolveIssueSource,
  resolveReportText,
  submitIssue,
} from "./issue_submit.ts";

Deno.test("requireNonBlank: rejects an empty or whitespace-only value", () => {
  for (const value of ["", " ", "   ", "\t", "\n", " \t\n "]) {
    const error = assertThrows(
      () => requireNonBlank("--body", value),
      UserError,
    );
    assertEquals(error.message, "--body must not be empty or only whitespace.");
  }
});

Deno.test("requireNonBlank: returns a value with content unchanged", () => {
  assertEquals(requireNonBlank("--title", "probe"), "probe");
  assertEquals(requireNonBlank("--title", "  padded  "), "  padded  ");
});

Deno.test("resolveReportText: both flags submit without the editor", () => {
  for (const mode of ["log", "json"] as const) {
    assertEquals(resolveReportText({ title: "t", body: "b" }, mode), {
      kind: "flags",
      title: "t",
      body: "b",
    });
  }
});

Deno.test("resolveReportText: --body without --title is refused", () => {
  for (const mode of ["log", "json"] as const) {
    const error = assertThrows(
      () => resolveReportText({ body: "b" }, mode),
      UserError,
    );
    assertEquals(error.message, "--body requires --title to be specified");
  }
});

Deno.test("resolveReportText: --title alone opens the editor with the title pre-filled", () => {
  assertEquals(resolveReportText({ title: "probe" }, "log"), {
    kind: "editor",
    prefilledTitle: "probe",
  });
});

Deno.test("resolveReportText: --title alone with --json names the missing --body", () => {
  const error = assertThrows(
    () => resolveReportText({ title: "probe" }, "json"),
    UserError,
  );
  assertEquals(
    error.message,
    "--title requires --body with --json (interactive mode is not available).",
  );
});

Deno.test("resolveReportText: a blank --title alone is refused before the editor", () => {
  for (const mode of ["log", "json"] as const) {
    const error = assertThrows(
      () => resolveReportText({ title: " " }, mode),
      UserError,
    );
    assertEquals(
      error.message,
      "--title must not be empty or only whitespace.",
    );
  }
});

Deno.test("resolveReportText: --title alone that the editor can't read back is refused", () => {
  for (
    const title of ["#123 crash", "  # heading", "<Command> fails", "a\nb"]
  ) {
    const error = assertThrows(
      () => resolveReportText({ title }, "log"),
      UserError,
    );
    assertEquals(
      error.message,
      '--title without --body must be one line that does not start with "#" or "<". Pass --body as well, or type the title in the editor.',
    );
  }
  // With --body the editor is skipped, so the same title is accepted.
  assertEquals(resolveReportText({ title: "#123 crash", body: "b" }, "log"), {
    kind: "flags",
    title: "#123 crash",
    body: "b",
  });
});

Deno.test("resolveReportText: no flags opens the editor, or refuses with --json", () => {
  assertEquals(resolveReportText({}, "log"), { kind: "editor" });
  const error = assertThrows(
    () => resolveReportText({}, "json"),
    UserError,
  );
  assertEquals(
    error.message,
    "Interactive mode is not available with --json. Use --title and --body options.",
  );
});

Deno.test("prefillTitle: puts the title on the line under the Title comment", () => {
  const template =
    "# Report\n\n## Title\n<!-- title below -->\n\n\n## Description\n";
  assertEquals(
    prefillTitle(template, "probe $& $1"),
    "# Report\n\n## Title\n<!-- title below -->\nprobe $& $1\n\n\n## Description\n",
  );
  assertEquals(prefillTitle(template, undefined), template);
});

Deno.test("buildMailtoUrl: builds correct mailto URL for bug", () => {
  const url = buildMailtoUrl("bug", "CLI crash", "Steps to reproduce");
  assertEquals(url.startsWith("mailto:support@swamp-club.com?"), true);
  assertEquals(url.includes("subject=%5Bbug%5D%20CLI%20crash"), true);
  assertEquals(url.includes("body=Steps%20to%20reproduce"), true);
  // Verify no + encoding (RFC 6068 requires %20)
  assertEquals(url.includes("+"), false);
});

Deno.test("buildMailtoUrl: builds correct mailto URL for feature", () => {
  const url = buildMailtoUrl("feature", "Dark mode", "Would be nice");
  assertEquals(url.includes("subject=%5Bfeature%5D%20Dark%20mode"), true);
});

Deno.test("buildMailtoUrl: builds correct mailto URL for security", () => {
  const url = buildMailtoUrl("security", "XSS vuln", "Details");
  assertEquals(url.includes("subject=%5Bsecurity%5D%20XSS%20vuln"), true);
});

Deno.test("buildMailtoUrl: handles special characters", () => {
  const url = buildMailtoUrl("bug", "Test & <stuff>", "Body with &amp;");
  // Should be percent-encoded, not HTML-encoded
  assertEquals(url.includes("&amp;"), false);
  assertEquals(url.includes("%26"), true);
});

// ---- Reports that can't be filed ----

const testCtx: CommandContext = {
  outputMode: "json",
  forceLog: false,
  verbosity: "normal",
  logger: getSwampLogger(["issue", "test"]),
};

async function withRepo(
  manifest: string | null,
  fn: (repo: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "swamp_issue_submit_" });
  try {
    await Deno.writeTextFile(join(repo, ".swamp.yaml"), "repo: {}\n");
    await Deno.mkdir(join(repo, ".swamp"), { recursive: true });
    if (manifest !== null) {
      const extDir = join(repo, ".swamp", "pulled-extensions", "@adam/cfgmgmt");
      await Deno.mkdir(extDir, { recursive: true });
      await Deno.writeTextFile(join(extDir, "manifest.yaml"), manifest);
    }
    await fn(repo);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
}

Deno.test("resolveExtensionOrRefuse: throws a not-pulled UserError when the extension is not installed", async () => {
  await withRepo(null, async (repo) => {
    const error = await assertRejects(
      () => resolveExtensionOrRefuse("@adam/cfgmgmt", repo),
      UserError,
    );
    assertEquals(error.code, "not-pulled");
    assertStringIncludes(
      error.message,
      "Report not filed against @adam/cfgmgmt.",
    );
    assertStringIncludes(error.message, "swamp extension pull @adam/cfgmgmt");
  });
});

Deno.test("resolveExtensionOrRefuse: throws a no-repository UserError when the manifest declares no repository", async () => {
  await withRepo(
    `manifestVersion: 1\nname: "@adam/cfgmgmt"\nversion: "2026.04.22.1"\nmodels:\n  - foo.yaml\n`,
    async (repo) => {
      const error = await assertRejects(
        () => resolveExtensionOrRefuse("@adam/cfgmgmt", repo),
        UserError,
      );
      assertEquals(error.code, "no-repository");
      assertStringIncludes(
        error.message,
        "Report not filed against @adam/cfgmgmt.",
      );
      assertStringIncludes(error.message, "does not declare a repository");
    },
  );
});

Deno.test("dispatchExtensionRepositoryReport: throws a pvr-disabled UserError for a security report", async () => {
  const createIssueCalls: string[][] = [];
  const ghRunner: GhCliRunner = {
    run(args) {
      if (args[0] === "api") {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ enabled: false }),
          stderr: "",
        });
      }
      if (args[0] === "issue") createIssueCalls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  const repositoryUrl = "https://github.com/adam/cfgmgmt";

  const error = await assertRejects(
    () =>
      dispatchExtensionRepositoryReport(
        testCtx,
        {
          kind: "repository",
          extensionName: "@adam/cfgmgmt",
          extensionVersion: "2026.04.22.1",
          repositoryUrl,
          parsed: parseRepositoryUrl(repositoryUrl),
        },
        { type: "security", title: "vuln", body: "details" },
        {
          ghRunner,
          env: { get: () => undefined },
          openBrowser: () => Promise.resolve(),
          writeLog: () => {},
        },
      ),
    UserError,
  );
  assertEquals(error.code, "pvr-disabled");
  assertStringIncludes(
    error.message,
    "Report not filed against @adam/cfgmgmt.",
  );
  assertEquals(createIssueCalls.length, 0);
});

Deno.test("submitIssue: throws a UserError telling the user to log in when the destination is abort", async () => {
  const error = await assertRejects(
    () =>
      submitIssue(testCtx, { method: "abort" }, {
        type: "bug",
        title: "",
        body: "",
      }),
    UserError,
  );
  assertStringIncludes(error.message, "swamp auth login");
  assertStringIncludes(error.message, "--email");
});

Deno.test("submitIssue: leaves out the --email hint on the extension path, where --email is rejected", async () => {
  const error = await assertRejects(
    () =>
      submitIssue(testCtx, { method: "abort" }, {
        type: "bug",
        title: "",
        body: "",
        swampLabTarget: {
          kind: "swamp-lab",
          extensionName: "@swamp/aws/ec2",
          extensionVersion: "2026.04.22.1",
        },
      }),
    UserError,
  );
  assertStringIncludes(error.message, "swamp auth login");
  assertEquals(error.message.includes("--email"), false);
});

// --- Redaction prompt at the submission entry points (swamp-club#3686) ---

const logCtx: CommandContext = { ...testCtx, outputMode: "log" };

function answering(answer: string): RedactionConfirmDeps {
  return { isInteractive: () => true, ask: () => Promise.resolve(answer) };
}

const redactable = { title: "Ping fails", body: "host 10.20.30.40 is down" };

Deno.test("resolveIssueSource: no --source leaves the default in place", () => {
  assertEquals(resolveIssueSource({}), undefined);
  assertEquals(resolveIssueSource({ email: true }), undefined);
  assertEquals(resolveIssueSource({ extension: "@adam/cfgmgmt" }), undefined);
});

Deno.test("resolveIssueSource: returns an accepted source", () => {
  assertEquals(resolveIssueSource({ source: "platform" }), "platform");
  assertEquals(resolveIssueSource({ source: "swamp" }), "swamp");
});

Deno.test("resolveIssueSource: refuses --source with --extension or --email", () => {
  for (const source of ["swamp", "platform"]) {
    const withExtension = assertThrows(
      () => resolveIssueSource({ source, extension: "@adam/cfgmgmt" }),
      UserError,
    );
    assertStringIncludes(withExtension.message, "--extension");
    const withEmail = assertThrows(
      () => resolveIssueSource({ source, email: true }),
      UserError,
    );
    assertStringIncludes(withEmail.message, "--email");
  }
});

Deno.test("resolveIssueSource: refuses a source the CLI cannot file with", () => {
  assertThrows(
    () => resolveIssueSource({ source: "swamp-club" }),
    UserError,
    "--source must be one of",
  );
});

Deno.test("resolveDestination: a lab-only report is refused without prompting when not logged in", async () => {
  const configDir = await Deno.makeTempDir({ prefix: "swamp_issue_source_" });
  try {
    const error = await withMockedEnv(
      {
        SWAMP_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: configDir,
        SWAMP_API_KEY: undefined,
        SWAMP_API_KEY_FILE: undefined,
      },
      () =>
        assertRejects(
          () => resolveDestination(logCtx, false, false, true),
          UserError,
        ),
    );
    assertStringIncludes(error.message, "swamp auth login");
    assertEquals(error.message.includes("--email"), false);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(configDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(configDir, { recursive: true });
    }
  }
});

Deno.test("submitIssue: sends the chosen source to the Lab", async () => {
  const { calls } = await withMockedFetch(
    () =>
      Promise.resolve(
        Response.json({ issue: { number: 7, id: "id" } }, { status: 201 }),
      ),
    () =>
      submitIssue(
        testCtx,
        {
          method: "lab",
          credentials: {
            serverUrl: "https://swamp-club.invalid",
            apiKey: "swamp_test",
            apiKeyId: "test",
            username: "tester",
          },
        },
        {
          type: "bug",
          title: "Lab filter is broken",
          body: "Details",
          source: "platform",
        },
      ),
  );
  assertEquals(calls.length, 1);
  assertEquals(JSON.parse(calls[0].body ?? "{}").source, "platform");
});

Deno.test("submitIssue: a timed-out report with a chosen source does not suggest --email", async () => {
  await withMockedFetch(
    () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    async () => {
      const error = await assertRejects(
        () =>
          submitIssue(
            testCtx,
            {
              method: "lab",
              credentials: {
                serverUrl: "https://swamp-club.invalid",
                apiKey: "swamp_test",
                apiKeyId: "test",
                username: "tester",
              },
            },
            {
              type: "bug",
              title: "Lab filter is broken",
              body: "Details",
              source: "platform",
            },
          ),
        UserError,
      );
      assertStringIncludes(error.message, "has not been lost");
      assertEquals(error.message.includes("--email"), false);
    },
  );
});

Deno.test("submitIssue: cancelling at the redaction prompt sends nothing", async () => {
  const { calls } = await withMockedFetch(
    () => Promise.resolve(new Response("{}", { status: 500 })),
    () =>
      submitIssue(
        logCtx,
        {
          method: "lab",
          credentials: {
            serverUrl: "https://swamp-club.invalid",
            apiKey: "swamp_test",
            apiKeyId: "test",
            username: "tester",
          },
        },
        { type: "bug", ...redactable },
        { confirm: answering("n") },
      ),
  );
  assertEquals(calls.length, 0);
});

async function dispatchAnswering(answer: string): Promise<{
  opened: string[];
  ghCalls: string[][];
}> {
  const opened: string[] = [];
  const ghCalls: string[][] = [];
  const repositoryUrl = "https://github.com/adam/cfgmgmt";
  await dispatchExtensionRepositoryReport(
    logCtx,
    {
      kind: "repository",
      extensionName: "@adam/cfgmgmt",
      extensionVersion: "2026.04.22.1",
      repositoryUrl,
      parsed: parseRepositoryUrl(repositoryUrl),
    },
    { type: "bug", ...redactable },
    {
      // gh is unavailable, so the report goes to the browser handoff.
      ghRunner: {
        run(args) {
          ghCalls.push(args);
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
        },
      },
      env: { get: () => undefined },
      openBrowser: (url) => {
        opened.push(decodeURIComponent(url.replaceAll("+", " ")));
        return Promise.resolve();
      },
      writeLog: () => {},
      confirm: answering(answer),
    },
  );
  return { opened, ghCalls };
}

Deno.test("dispatchExtensionRepositoryReport: the redaction prompt decides what is sent", async () => {
  const redacted = await dispatchAnswering("y");
  assertEquals(redacted.opened.length, 1);
  assertStringIncludes(redacted.opened[0], "host [IP-1] is down");

  const asWritten = await dispatchAnswering("w");
  assertEquals(asWritten.opened.length, 1);
  assertStringIncludes(asWritten.opened[0], "host 10.20.30.40 is down");

  const cancelled = await dispatchAnswering("");
  assertEquals(cancelled.opened, []);
  assertEquals(cancelled.ghCalls, []);
});
