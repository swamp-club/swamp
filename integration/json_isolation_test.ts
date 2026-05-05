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

/**
 * JSON-mode output isolation regression tests.
 *
 * Asserts the contract that under `--json`, stdout is exactly one parseable
 * JSON document and is not interleaved with log records. Without `--json`,
 * the same commands still produce expected output (sanity check that the
 * JSON-mode logger config doesn't accidentally suppress log-mode output).
 *
 * Tracks issue swamp-club#235.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-json-isolation-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("--json: version stdout is parseable JSON", async () => {
  const { stdout, code } = await runCliCommand(
    ["version", "--json"],
    Deno.cwd(),
  );
  assertEquals(code, 0);
  // Must parse as a single JSON document.
  const parsed = JSON.parse(stdout);
  assertEquals(typeof parsed.version, "string");
});

Deno.test("--json: error path emits exactly one JSON document on stdout", async () => {
  // `data list` without a model name fails with a UserError. The renderError
  // path should write the error JSON to stdout exactly once — no double
  // emission and no LogTape pretty-formatted FTL line.
  await withTempDir(async (dir) => {
    await initializeTestRepo(dir);
    const { stdout, code } = await runCliCommand(
      ["data", "list", "--json"],
      dir,
    );
    assertEquals(code, 1);
    // Parse must succeed with one document. If the double-emission bug
    // returns, stdout would have two concatenated JSON objects which
    // JSON.parse rejects.
    const parsed = JSON.parse(stdout);
    assertEquals(typeof parsed.error, "string");
  });
});

Deno.test("--json: stdout has no LogTape pretty-formatted log lines", async () => {
  // `INF` / `WRN` / `ERR` prefixes are the LogTape pretty formatter's
  // hallmark. They must never appear on stdout under --json.
  await withTempDir(async (dir) => {
    await initializeTestRepo(dir);
    const { stdout } = await runCliCommand(["data", "list", "--json"], dir);
    // Must not contain LogTape level prefixes.
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+(INF|WRN|ERR|DBG|FTL)\s/m.test(stdout)) {
      throw new Error(
        `stdout contained LogTape pretty log line:\n${stdout}`,
      );
    }
  });
});

Deno.test("--json: model method run stdout is parseable JSON", async () => {
  // Exercises the model.method.run logger category specifically — the
  // category most affected by the parentSinks: 'override' fix.
  await withTempDir(async (dir) => {
    await initializeTestRepo(dir);
    const create = await runCliCommand(
      ["model", "create", "command/shell", "smoke", "--json"],
      dir,
    );
    assertEquals(create.code, 0);
    JSON.parse(create.stdout); // must parse

    const run = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "smoke",
        "execute",
        "--input",
        "run=echo hi",
        "--json",
      ],
      dir,
    );
    assertEquals(run.code, 0);
    const result = JSON.parse(run.stdout);
    assertEquals(result.status, "succeeded");
    // Stdout must not contain LogTape pretty-formatted log lines.
    if (
      /^\d{2}:\d{2}:\d{2}\.\d{3}\s+(INF|WRN|ERR|DBG|FTL)\s/m.test(run.stdout)
    ) {
      throw new Error(
        `model method run --json leaked log lines on stdout:\n${run.stdout}`,
      );
    }
  });
});

Deno.test("log mode: version still emits version string", async () => {
  // Sanity check: the JSON-mode logger isolation must not regress log-mode
  // output. version in log mode prints the version through the logger.
  const { stdout, code } = await runCliCommand(["version"], Deno.cwd());
  assertEquals(code, 0);
  // Either stdout or stderr should contain the version string. The
  // version command uses logger.info which goes to console (stderr by
  // default in many LogTape configs); accept either.
  const out = stdout;
  // Version string is a number-prefixed identifier; look for the year prefix.
  if (!/202\d/.test(out)) {
    // Allow it on stderr too.
    const cmd = await runCliCommand(["version"], Deno.cwd());
    if (!/202\d/.test(cmd.stdout) && !/202\d/.test(cmd.stderr ?? "")) {
      throw new Error(
        `version command produced no version string. stdout=${out}`,
      );
    }
  }
});

Deno.test("log mode: model method run still emits log records", async () => {
  // Sanity: without --json, method run should produce log output (the
  // method-summary report, status lines, etc.) so the JSON-mode fix
  // didn't accidentally silence log mode.
  await withTempDir(async (dir) => {
    await initializeTestRepo(dir);
    await runCliCommand(
      ["model", "create", "command/shell", "smoke-log", "--json"],
      dir,
    );

    const run = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "smoke-log",
        "execute",
        "--input",
        "run=echo hi",
      ],
      dir,
    );
    assertEquals(run.code, 0);
    // Log mode should produce SOME output across stdout+stderr — the
    // method summary report at minimum.
    const combined = run.stdout + run.stderr;
    assertStringIncludes(combined, "succeeded");
  });
});
