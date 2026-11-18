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
import {
  setConsoleGuardStderrWriter,
  withConsoleGuard,
} from "../../domain/models/console_guard.ts";
import { runFileSink } from "../../infrastructure/logging/run_file_sink.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { writeServeJsonLine } from "./serve_json_line.ts";

Deno.test("writeServeJsonLine: reaches stdout and stays out of a running method's logs", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => stdout.push(msg);
  setConsoleGuardStderrWriter((line) => stderr.push(line));
  const logs: string[] = [];

  try {
    await withConsoleGuard(
      () => writeServeJsonLine(JSON.stringify({ status: "stopping" })),
      logs,
      { jsonMode: true },
    );

    assertEquals(stdout, ['{"status":"stopping"}']);
    assertEquals(stderr, []);
    assertEquals(logs, []);
  } finally {
    console.log = originalLog;
    setConsoleGuardStderrWriter(undefined);
  }
});

Deno.test("writeServeJsonLine: writes to stdout when no method is running", () => {
  const stdout: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => stdout.push(msg);

  try {
    writeServeJsonLine(JSON.stringify({ status: "stopped" }));

    assertEquals(stdout, ['{"status":"stopped"}']);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("writeServeJsonLine: masks an active run's secrets", async () => {
  const redactor = new SecretRedactor();
  redactor.addSecret("serve-line-secret-4884");
  const handle = runFileSink.registerRedactor(redactor);
  const stdout: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => stdout.push(msg);
  setConsoleGuardStderrWriter(() => {});

  try {
    writeServeJsonLine(
      JSON.stringify({
        kind: "webhook_failed",
        error: "serve-line-secret-4884",
      }),
    );
    await withConsoleGuard(
      () =>
        writeServeJsonLine(
          JSON.stringify({
            status: "aborting",
            note: "serve-line-secret-4884",
          }),
        ),
      [],
      { jsonMode: true },
    );

    assertEquals(stdout, [
      '{"kind":"webhook_failed","error":"***"}',
      '{"status":"aborting","note":"***"}',
    ]);
  } finally {
    console.log = originalLog;
    setConsoleGuardStderrWriter(undefined);
    runFileSink.unregisterRedactor(handle);
  }
});
