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

import { UserError } from "../../domain/errors.ts";

/** cap on gh subprocesses so a slow or broken gh install does not stall the CLI */
const GH_TIMEOUT_MS = 3000;

export interface GhCliRunner {
  run(
    args: string[],
    opts?: { stdin?: string; timeoutMs?: number },
  ): Promise<GhRunResult>;
}

export interface GhRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnFailed?: boolean;
  timedOut?: boolean;
}

export const defaultGhRunner: GhCliRunner = {
  async run(args, opts) {
    const timeoutMs = opts?.timeoutMs ?? GH_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const cmd = new Deno.Command("gh", {
        args,
        stdin: opts?.stdin !== undefined ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
      });
      const child = cmd.spawn();
      if (opts?.stdin !== undefined) {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(opts.stdin));
        await writer.close();
      }
      const output = await child.output();
      return {
        exitCode: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
        timedOut: controller.signal.aborted,
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { exitCode: -1, stdout: "", stderr: "", spawnFailed: true };
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },
};

/**
 * with GH_TOKEN or GITHUB_TOKEN set, gh needs no auth check; otherwise gh auth
 * status runs, and a non-zero exit, missing binary or timeout means false
 */
export async function isGhCliAvailable(
  runner: GhCliRunner = defaultGhRunner,
  env: { get(key: string): string | undefined } = {
    get: (key) => Deno.env.get(key),
  },
): Promise<boolean> {
  if (env.get("GH_TOKEN") || env.get("GITHUB_TOKEN")) return true;
  const result = await runner.run(["auth", "status"]);
  return result.exitCode === 0;
}

/**
 * false means security reports must not be filed as public issues; null means
 * the check failed, so fall back to the safer default of routing to the
 * advisory URL
 */
export async function checkGithubPvrEnabled(
  ownerRepo: string,
  runner: GhCliRunner = defaultGhRunner,
): Promise<boolean | null> {
  const result = await runner.run([
    "api",
    `repos/${ownerRepo}/private-vulnerability-reporting`,
  ]);
  if (result.spawnFailed || result.timedOut || result.exitCode !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (typeof parsed?.enabled === "boolean") return parsed.enabled;
    return null;
  } catch {
    return null;
  }
}

export interface CreateIssueInput {
  ownerRepo: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface CreateIssueResult {
  url: string;
  number: number;
}

/**
 * the body goes over stdin so it can be long and stays out of ps output; a
 * 401/403 gets distinct authenticated-but-not-authorised wording from other
 * failures
 */
export async function createGithubIssueViaGh(
  input: CreateIssueInput,
  runner: GhCliRunner = defaultGhRunner,
): Promise<CreateIssueResult> {
  const args: string[] = [
    "issue",
    "create",
    "--repo",
    input.ownerRepo,
    "--title",
    input.title,
    "--body-file",
    "-",
  ];
  if (input.labels && input.labels.length > 0) {
    args.push("--label", input.labels.join(","));
  }

  const result = await runner.run(args, {
    stdin: input.body,
    timeoutMs: 15_000,
  });

  if (result.spawnFailed) {
    throw new UserError("gh CLI not found on PATH.");
  }
  if (result.timedOut) {
    throw new UserError("gh issue create timed out.");
  }
  if (result.exitCode !== 0) {
    if (isAuthUnauthorisedError(result.stderr)) {
      throw new UserError(
        `gh is authenticated but not authorised to create issues on ${input.ownerRepo}. ` +
          `Check that your token has the required scope (public_repo or repo) and that you have ` +
          `write access to the repository.\n\n${result.stderr.trim()}`,
      );
    }
    throw new UserError(
      `gh issue create failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  const url = extractIssueUrl(result.stdout);
  if (!url) {
    throw new UserError(
      `gh issue create succeeded but returned no URL:\n${result.stdout}`,
    );
  }
  const number = extractIssueNumber(url);
  if (number === null) {
    throw new UserError(
      `gh issue create returned a URL without a parseable issue number: ${url}`,
    );
  }
  return { url, number };
}

function isAuthUnauthorisedError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("http 401") ||
    s.includes("http 403") ||
    s.includes("resource not accessible") ||
    s.includes("not authorized")
  );
}

function extractIssueUrl(stdout: string): string | undefined {
  const match = stdout.match(/https:\/\/github\.com\/[^\s]+\/issues\/\d+/);
  return match?.[0];
}

function extractIssueNumber(url: string): number | null {
  const match = url.match(/\/issues\/(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}
