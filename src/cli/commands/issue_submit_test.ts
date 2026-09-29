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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { parseRepositoryUrl } from "../../domain/extensions/repository_url.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { GhCliRunner } from "../../infrastructure/process/gh_cli.ts";
import type { CommandContext } from "../context.ts";
import {
  buildMailtoUrl,
  dispatchExtensionRepositoryReport,
  resolveExtensionOrRefuse,
  submitIssue,
} from "./issue_submit.ts";

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
