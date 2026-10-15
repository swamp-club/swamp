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
import { stripAnsiCode } from "@std/fmt/colors";
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

const EMPTY_BAR = "\u2500".repeat(30);

/**
 * A log renderer with a recording spinner, stderr and a settable clock.
 * Spinner messages are recorded without color; `calls` records the
 * spinner's stop and finish in order.
 */
function logRenderer(options: Partial<UpdateCheckRendererOptions> = {}) {
  const spinnerMessages: string[] = [];
  const calls: string[] = [];
  const stderr: string[] = [];
  let clock = 0;
  const renderer = createUpdateCheckRenderer("log", {
    spinner: {
      update: (message) => spinnerMessages.push(stripAnsiCode(message)),
      stop: () => calls.push("stop"),
      finish: (line) => calls.push(`finish ${stripAnsiCode(line)}`),
    },
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
    calls,
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

Deno.test("createUpdateCheckRenderer: on a terminal the spinner shows a bar, percent, bytes, speed and time left", () => {
  const r = logRenderer();

  r.at(0);
  r.send(progress(0));
  r.at(2000);
  r.send(progress(1 * MB));

  assertEquals(r.spinnerMessages, [
    `${EMPTY_BAR} 0% 0 B / 100.0 MB`,
    `${EMPTY_BAR} 1% 1.0 MB / 100.0 MB · 512.0 KB/s · ETA 3:18`,
  ]);
  assertEquals(r.stderr, []);
});

Deno.test("createUpdateCheckRenderer: the bar fills in half cells", () => {
  const r = logRenderer();

  r.send(progress(50 * MB));
  r.send(progress(52.5 * MB));
  r.send(progress(100 * MB));

  const bars = r.spinnerMessages.map((m) => m.slice(0, 30));
  assertEquals(bars, [
    "\u2501".repeat(15) + "\u2500".repeat(15),
    "\u2501".repeat(15) + "\u2578" + "\u2500".repeat(14),
    "\u2501".repeat(30),
  ]);
});

Deno.test("createUpdateCheckRenderer: the time left is shown only once a speed is known", () => {
  const r = logRenderer();

  r.at(0);
  r.send(progress(0));
  r.at(500);
  r.send(progress(1 * MB));

  assertEquals(r.spinnerMessages.some((m) => m.includes("ETA")), false);
});

Deno.test("createUpdateCheckRenderer: the bar shrinks to fit, then is left out", () => {
  const widths = [120, 40, 25].map((columns) => {
    const r = logRenderer({ columns: () => columns });
    r.send(progress(0));
    return r.spinnerMessages[0];
  });

  assertEquals(widths, [
    `${EMPTY_BAR} 0% 0 B / 100.0 MB`,
    `${"\u2500".repeat(20)} 0% 0 B / 100.0 MB`,
    "0% 0 B / 100.0 MB",
  ]);
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

  assertStringIncludes(
    r.spinnerMessages.at(-1)!,
    "50% 50.7 MB / 100.0 MB · 100.0 KB/s",
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

Deno.test("createUpdateCheckRenderer: -q writes no progress or retry lines to stderr", () => {
  const r = logRenderer({ stderrIsTerminal: false, quiet: true });

  for (let s = 0; s <= 25; s++) {
    r.at(s * 1000);
    r.send(progress(s * MB));
  }
  r.send({
    kind: "download_retrying",
    data: {
      attempt: 1,
      maxAttempts: 5,
      reason: "HTTP 503",
      resumeFromBytes: 0,
    },
  });

  assertEquals(r.stderr, []);
});

Deno.test("createUpdateCheckRenderer: -q leaves the spinner's live progress on a terminal", () => {
  const r = logRenderer({ quiet: true });

  r.send(progress(0));

  assertEquals(r.spinnerMessages, [`${EMPTY_BAR} 0% 0 B / 100.0 MB`]);
});

const UPDATED = {
  kind: "completed" as const,
  data: {
    status: "updated" as const,
    previousVersion: "20261001.0.0-sha.a",
    newVersion: "20261015.0.0-sha.b",
  },
};

/** Sends `event` and returns the spinner calls and stdout lines in order. */
function sendRecordingOrder(
  r: ReturnType<typeof logRenderer>,
  event: UpdateCheckEvent,
): string[] {
  const original = console.log;
  console.log = (...args: unknown[]) => r.calls.push(`out ${args.join(" ")}`);
  try {
    r.send(event);
  } finally {
    console.log = original;
  }
  return r.calls;
}

Deno.test("createUpdateCheckRenderer: an installed update finishes the spinner before printing", () => {
  const r = logRenderer();
  r.at(0);
  r.send(progress(0));
  r.at(12_000);
  r.send(progress(100 * MB));

  const order = sendRecordingOrder(r, UPDATED);

  assertEquals(
    order[0],
    `finish \u2713 ${
      "\u2501".repeat(30)
    } swamp 20261015.0.0-sha.b · 100.0 MB in 0:12`,
  );
  assertEquals(order[1], "out swamp updated successfully!");
});

Deno.test("createUpdateCheckRenderer: without a total the final line has no bar", () => {
  const r = logRenderer();
  r.at(0);
  r.send(progress(0, null));
  r.at(3000);
  r.send(progress(2 * MB, null));

  const order = sendRecordingOrder(r, UPDATED);

  assertEquals(
    order[0],
    "finish \u2713 swamp 20261015.0.0-sha.b · 2.0 MB in 0:03",
  );
});

Deno.test("createUpdateCheckRenderer: without any progress the final line is the check and version", () => {
  const r = logRenderer();

  const order = sendRecordingOrder(r, UPDATED);

  assertEquals(order[0], "finish \u2713 swamp 20261015.0.0-sha.b");
});

Deno.test("createUpdateCheckRenderer: a check result stops the spinner before printing", () => {
  for (
    const data of [
      { status: "up_to_date" as const, currentVersion: "1" },
      {
        status: "update_available" as const,
        currentVersion: "1",
        latestVersion: "2",
      },
    ]
  ) {
    const r = logRenderer();
    const order = sendRecordingOrder(r, { kind: "completed", data });
    assertEquals(order[0], "stop");
    assertEquals(order[1].startsWith("out "), true);
  }
});

Deno.test("createUpdateCheckRenderer: without a terminal an update adds nothing to stderr", () => {
  const r = logRenderer({ stderrIsTerminal: false });
  r.send(progress(100 * MB));
  const before = r.stderr.length;

  const order = sendRecordingOrder(r, UPDATED);

  assertEquals(order.some((c) => c.startsWith("finish")), false);
  assertEquals(r.stderr.length, before);
});
