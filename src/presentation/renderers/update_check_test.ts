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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { cancelled } from "../../libswamp/errors.ts";
import type { UpdateCheckEvent } from "../../libswamp/update/check.ts";
import {
  createUpdateCheckRenderer,
  renderUpdateCancelled,
  type UpdateCheckRendererOptions,
} from "./update_check.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

await initializeLogging({});

const MB = 1024 * 1024;

function progress(receivedBytes: number, totalBytes: number | null = 100 * MB) {
  return {
    kind: "download_progress" as const,
    data: { receivedBytes, totalBytes },
  };
}

/** A log renderer with a recording spinner, stderr and a settable clock. */
function logRenderer(options: Partial<UpdateCheckRendererOptions> = {}) {
  const spinnerMessages: string[] = [];
  const stderr: string[] = [];
  let clock = 0;
  const renderer = createUpdateCheckRenderer("log", {
    spinner: { update: (message) => spinnerMessages.push(message) },
    stderrIsTerminal: true,
    writeStderr: (line) => stderr.push(line),
    now: () => clock,
    columns: () => 120,
    ...options,
  });
  const handlers = renderer.handlers();
  return {
    renderer,
    spinnerMessages,
    stderr,
    at: (ms: number) => (clock = ms),
    send: (event: UpdateCheckEvent): void => {
      switch (event.kind) {
        case "checking":
          return void handlers.checking(event);
        case "download_progress":
          return void handlers.download_progress(event);
        case "download_retrying":
          return void handlers.download_retrying(event);
        case "completed":
          return void handlers.completed(event);
        case "error":
          return void handlers.error(event);
      }
    },
  };
}

Deno.test("createUpdateCheckRenderer: on a terminal the spinner shows bytes, total, percent and speed", () => {
  const r = logRenderer();

  r.at(0);
  r.send(progress(0));
  r.at(2000);
  r.send(progress(1 * MB));

  assertEquals(r.spinnerMessages, [
    "Downloading update 0 B / 100.0 MB (0%)",
    "Downloading update 1.0 MB / 100.0 MB (1%) · 512.0 KB/s",
  ]);
  assertEquals(r.stderr, []);
});

Deno.test("createUpdateCheckRenderer: without a total the line shows bytes received", () => {
  const r = logRenderer();

  r.send(progress(1536, null));

  assertEquals(r.spinnerMessages, ["Downloading update 1.5 KB"]);
});

Deno.test("createUpdateCheckRenderer: speed is averaged over the last few seconds only", () => {
  const r = logRenderer();

  r.at(0);
  r.send(progress(0));
  // A fast first stretch...
  r.at(1000);
  r.send(progress(50 * MB));
  // ...then a slow one: the window forgets the fast stretch.
  for (let s = 2; s <= 8; s++) {
    r.at(s * 1000);
    r.send(progress(50 * MB + (s - 1) * 100 * 1024));
  }

  assertEquals(
    r.spinnerMessages.at(-1),
    "Downloading update 50.7 MB / 100.0 MB (50%) · 100.0 KB/s",
  );
});

Deno.test("createUpdateCheckRenderer: without a terminal a progress line goes to stderr at most every 10s", () => {
  const r = logRenderer({ stderrIsTerminal: false });

  for (let s = 0; s <= 25; s++) {
    r.at(s * 1000);
    r.send(progress(s * MB));
  }

  assertEquals(r.stderr.length, 3);
  assertEquals(r.stderr[0], "Downloading update 0 B / 100.0 MB (0%)");
  assertEquals(
    r.stderr[2],
    "Downloading update 20.0 MB / 100.0 MB (20%) · 1.0 MB/s",
  );
  assertEquals(r.spinnerMessages, []);
});

Deno.test("createUpdateCheckRenderer: a retry is reported at once with its reason and resume point", () => {
  const r = logRenderer({ stderrIsTerminal: false });
  r.send(progress(0));

  r.send({
    kind: "download_retrying",
    data: {
      attempt: 1,
      maxAttempts: 5,
      reason: "no data received for 30s",
      resumeFromBytes: 53 * MB,
    },
  });

  assertEquals(
    r.stderr.at(-1),
    "Retrying download from 53.0 MB (attempt 2/5): no data received for 30s",
  );
});

Deno.test("createUpdateCheckRenderer: a cancel is recorded, not thrown, in both modes", () => {
  const log = logRenderer();
  log.send({ kind: "error", error: cancelled() });
  assertEquals(log.renderer.cancelled, true);
  assertEquals(log.renderer.updated, false);

  const json = createUpdateCheckRenderer("json");
  json.handlers().error({ kind: "error", error: cancelled() });
  assertEquals(json.cancelled, true);
});

Deno.test("createUpdateCheckRenderer: other errors are still thrown", () => {
  const r = logRenderer();
  assertThrows(
    () =>
      r.send({
        kind: "error",
        error: { code: "network", message: "Download failed" },
      }),
    UserError,
    "Download failed",
  );
  assertEquals(r.renderer.cancelled, false);
});

Deno.test("createUpdateCheckRenderer: json mode prints no progress", () => {
  const logged: unknown[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logged.push(args);
  try {
    const handlers = createUpdateCheckRenderer("json").handlers();
    handlers.download_progress(progress(MB));
    handlers.download_retrying({
      kind: "download_retrying",
      data: {
        attempt: 1,
        maxAttempts: 5,
        reason: "HTTP 503",
        resumeFromBytes: 0,
      },
    });
  } finally {
    console.log = original;
  }
  assertEquals(logged, []);
});

Deno.test("createUpdateCheckRenderer: on a terminal a line is cut to fit, so the spinner never wraps", () => {
  const r = logRenderer({ columns: () => 40 });

  r.send({
    kind: "download_retrying",
    data: {
      attempt: 1,
      maxAttempts: 5,
      reason: "error reading a body from connection",
      resumeFromBytes: 53 * MB,
    },
  });

  const shown = r.spinnerMessages.at(-1)!;
  assertEquals(shown.length, 38);
  assertEquals(shown, "Retrying download from 53.0 MB (attem\u2026");
});

Deno.test("createUpdateCheckRenderer: without a terminal lines are not cut", () => {
  const r = logRenderer({ stderrIsTerminal: false, columns: () => 40 });

  r.send({
    kind: "download_retrying",
    data: {
      attempt: 1,
      maxAttempts: 5,
      reason: "error reading a body from connection",
      resumeFromBytes: 0,
    },
  });

  assertEquals(
    r.stderr.at(-1),
    "Retrying download (attempt 2/5): error reading a body from connection",
  );
});

/** Runs `fn`, returning what it wrote through each console method. */
function captureConsole(fn: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    error: console.error,
  };
  console.log = (...args: unknown[]) => out.push(args.join(" "));
  console.info = (...args: unknown[]) => out.push(args.join(" "));
  console.error = (...args: unknown[]) => err.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.error = original.error;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

Deno.test("renderUpdateCancelled: log mode prints a plain line, not an error", () => {
  const { out, err } = captureConsole(() =>
    renderUpdateCancelled("log", false)
  );

  assertStringIncludes(
    out,
    "Update cancelled. The installed swamp binary was not changed.",
  );
  assertEquals(out.includes("Error:"), false);
  assertEquals(err, "");
});

Deno.test("renderUpdateCancelled: json mode writes the error with code cancelled to stderr", () => {
  const { out, err } = captureConsole(() =>
    renderUpdateCancelled("json", false)
  );

  assertEquals(out, "");
  assertEquals(JSON.parse(err), {
    error: "Update cancelled. The installed swamp binary was not changed.",
    code: "cancelled",
  });
});

Deno.test("renderUpdateCancelled: a cancelled check says only the check was cancelled", () => {
  const { err } = captureConsole(() => renderUpdateCancelled("json", true));

  assertEquals(JSON.parse(err).error, "Update check cancelled.");
});
