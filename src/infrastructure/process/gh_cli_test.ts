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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import {
  checkGithubPvrEnabled,
  createGithubIssueViaGh,
  type GhCliRunner,
  type GhRunResult,
  isGhCliAvailable,
} from "./gh_cli.ts";

/** Test runner that records calls and returns pre-programmed responses. */
function fakeRunner(
  responses: Array<(args: string[], stdin?: string) => GhRunResult>,
): GhCliRunner & { calls: Array<{ args: string[]; stdin?: string }> } {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  let idx = 0;
  const runner: GhCliRunner = {
    run(args, opts) {
      calls.push({ args, stdin: opts?.stdin });
      const handler = responses[Math.min(idx, responses.length - 1)];
      idx++;
      return Promise.resolve(handler(args, opts?.stdin));
    },
  };
  return Object.assign(runner, { calls });
}

function fakeEnv(
  values: Record<string, string | undefined> = {},
): { get(key: string): string | undefined } {
  return { get: (key) => values[key] };
}

// ---- isGhCliAvailable ----

Deno.test("isGhCliAvailable: GH_TOKEN fast path returns true without subprocess", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: 0, stdout: "", stderr: "" }),
  ]);
  const env = fakeEnv({ GH_TOKEN: "ghp_x" });
  const result = await isGhCliAvailable(runner, env);
  assertEquals(result, true);
  assertEquals(runner.calls.length, 0);
});

Deno.test("isGhCliAvailable: GITHUB_TOKEN fast path also returns true", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: 0, stdout: "", stderr: "" }),
  ]);
  const env = fakeEnv({ GITHUB_TOKEN: "ghp_x" });
  const result = await isGhCliAvailable(runner, env);
  assertEquals(result, true);
  assertEquals(runner.calls.length, 0);
});

Deno.test("isGhCliAvailable: shells out to gh auth status when no env token", async () => {
  const runner = fakeRunner([
    (args) => {
      assertEquals(args, ["auth", "status"]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  ]);
  const result = await isGhCliAvailable(runner, fakeEnv());
  assertEquals(result, true);
});

Deno.test("isGhCliAvailable: returns false when gh auth status exits non-zero", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: 1, stdout: "", stderr: "not logged in" }),
  ]);
  const result = await isGhCliAvailable(runner, fakeEnv());
  assertEquals(result, false);
});

Deno.test("isGhCliAvailable: returns false when gh is not installed", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: -1, stdout: "", stderr: "", spawnFailed: true }),
  ]);
  const result = await isGhCliAvailable(runner, fakeEnv());
  assertEquals(result, false);
});

Deno.test("isGhCliAvailable: returns false when gh auth status times out", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }),
  ]);
  const result = await isGhCliAvailable(runner, fakeEnv());
  assertEquals(result, false);
});

// ---- checkGithubPvrEnabled ----

Deno.test("checkGithubPvrEnabled: returns true when API reports enabled", async () => {
  const runner = fakeRunner([
    (args) => {
      assertEquals(args, [
        "api",
        "repos/adam/cfgmgmt/private-vulnerability-reporting",
      ]);
      return { exitCode: 0, stdout: '{"enabled":true}', stderr: "" };
    },
  ]);
  const result = await checkGithubPvrEnabled("adam/cfgmgmt", runner);
  assertEquals(result, true);
});

Deno.test("checkGithubPvrEnabled: returns false when API reports disabled", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: 0, stdout: '{"enabled":false}', stderr: "" }),
  ]);
  const result = await checkGithubPvrEnabled("adam/cfgmgmt", runner);
  assertEquals(result, false);
});

Deno.test("checkGithubPvrEnabled: returns null on subprocess failure", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: 1, stdout: "", stderr: "HTTP 403" }),
  ]);
  const result = await checkGithubPvrEnabled("adam/cfgmgmt", runner);
  assertEquals(result, null);
});

Deno.test("checkGithubPvrEnabled: returns null on spawn failure", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: -1, stdout: "", stderr: "", spawnFailed: true }),
  ]);
  const result = await checkGithubPvrEnabled("adam/cfgmgmt", runner);
  assertEquals(result, null);
});

Deno.test("checkGithubPvrEnabled: returns null on timeout", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }),
  ]);
  const result = await checkGithubPvrEnabled("adam/cfgmgmt", runner);
  assertEquals(result, null);
});

Deno.test("checkGithubPvrEnabled: returns null when response is not parseable JSON", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
  ]);
  const result = await checkGithubPvrEnabled("adam/cfgmgmt", runner);
  assertEquals(result, null);
});

Deno.test("checkGithubPvrEnabled: returns null when response lacks 'enabled' key", async () => {
  const runner = fakeRunner([
    () => ({ exitCode: 0, stdout: '{"something":"else"}', stderr: "" }),
  ]);
  const result = await checkGithubPvrEnabled("adam/cfgmgmt", runner);
  assertEquals(result, null);
});

// ---- createGithubIssueViaGh ----

Deno.test("createGithubIssueViaGh: passes body via stdin, returns parsed result", async () => {
  const runner = fakeRunner([
    (args, stdin) => {
      assertEquals(args, [
        "issue",
        "create",
        "--repo",
        "adam/cfgmgmt",
        "--title",
        "Boom",
        "--body-file",
        "-",
      ]);
      assertEquals(stdin, "body text");
      return {
        exitCode: 0,
        stdout: "https://github.com/adam/cfgmgmt/issues/42\n",
        stderr: "",
      };
    },
  ]);
  const result = await createGithubIssueViaGh({
    ownerRepo: "adam/cfgmgmt",
    title: "Boom",
    body: "body text",
  }, runner);
  assertEquals(result.number, 42);
  assertEquals(result.url, "https://github.com/adam/cfgmgmt/issues/42");
});

Deno.test("createGithubIssueViaGh: appends --label when labels provided", async () => {
  const runner = fakeRunner([
    (args) => {
      assertStringIncludes(args.join(" "), "--label swamp-extension,bug");
      return {
        exitCode: 0,
        stdout: "https://github.com/a/b/issues/1\n",
        stderr: "",
      };
    },
  ]);
  await createGithubIssueViaGh({
    ownerRepo: "a/b",
    title: "t",
    body: "b",
    labels: ["swamp-extension", "bug"],
  }, runner);
});

Deno.test("createGithubIssueViaGh: surfaces 401 as auth-unauthorised error", async () => {
  const runner = fakeRunner([
    () => ({
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 401: Bad credentials",
    }),
  ]);
  await assertRejects(
    () =>
      createGithubIssueViaGh({
        ownerRepo: "a/b",
        title: "t",
        body: "b",
      }, runner),
    UserError,
    "authenticated but not authorised",
  );
});

Deno.test("createGithubIssueViaGh: surfaces 403 as auth-unauthorised error", async () => {
  const runner = fakeRunner([
    () => ({
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 403: Resource not accessible by integration",
    }),
  ]);
  await assertRejects(
    () =>
      createGithubIssueViaGh({
        ownerRepo: "a/b",
        title: "t",
        body: "b",
      }, runner),
    UserError,
    "authenticated but not authorised",
  );
});

Deno.test("createGithubIssueViaGh: generic failure includes stderr", async () => {
  const runner = fakeRunner([
    () => ({
      exitCode: 1,
      stdout: "",
      stderr: "something broke",
    }),
  ]);
  await assertRejects(
    () =>
      createGithubIssueViaGh({
        ownerRepo: "a/b",
        title: "t",
        body: "b",
      }, runner),
    UserError,
    "something broke",
  );
});

Deno.test("createGithubIssueViaGh: spawn failure produces a clear error", async () => {
  const runner = fakeRunner([
    () => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
      spawnFailed: true,
    }),
  ]);
  await assertRejects(
    () =>
      createGithubIssueViaGh({
        ownerRepo: "a/b",
        title: "t",
        body: "b",
      }, runner),
    UserError,
    "gh CLI not found",
  );
});

Deno.test("createGithubIssueViaGh: timeout produces a clear error", async () => {
  const runner = fakeRunner([
    () => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: true,
    }),
  ]);
  await assertRejects(
    () =>
      createGithubIssueViaGh({
        ownerRepo: "a/b",
        title: "t",
        body: "b",
      }, runner),
    UserError,
    "timed out",
  );
});

Deno.test("createGithubIssueViaGh: failure when stdout has no URL", async () => {
  const runner = fakeRunner([
    () => ({
      exitCode: 0,
      stdout: "no url here",
      stderr: "",
    }),
  ]);
  await assertRejects(
    () =>
      createGithubIssueViaGh({
        ownerRepo: "a/b",
        title: "t",
        body: "b",
      }, runner),
    UserError,
    "returned no URL",
  );
});

Deno.test("createGithubIssueViaGh: large body is passed verbatim via stdin", async () => {
  const huge = "x".repeat(200_000);
  const runner = fakeRunner([
    (_args, stdin) => {
      assertEquals(stdin, huge);
      return {
        exitCode: 0,
        stdout: "https://github.com/a/b/issues/1\n",
        stderr: "",
      };
    },
  ]);
  await createGithubIssueViaGh({
    ownerRepo: "a/b",
    title: "t",
    body: huge,
  }, runner);
});
