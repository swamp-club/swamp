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
import { UserError } from "../domain/errors.ts";
import {
  promptChoice,
  promptConfirmation,
  promptLine,
  promptLineWithDefault,
  promptNumberedChoice,
} from "./prompt_helpers.ts";

// ---------------------------------------------------------------------------
// Test helpers — stub Deno.stdin.read and both output streams so the prompt
// functions can be tested without a real TTY.
//
// Both streams are captured, not just the one prompts use: `written` holds
// stderr, where prompts belong, and `stdoutWritten` holds stdout, which must
// stay empty. stdout is the command's value for `vault read-secret` and
// friends, and a prompt written there lands in the user's redirect target
// (swamp-club#2260).
// ---------------------------------------------------------------------------

function fakeStdinRead(
  input: string | null | Array<string | null>,
): (buf: Uint8Array) => Promise<number | null> {
  const encoder = new TextEncoder();
  // An array answers one read per entry, in order; a single value answers
  // every read.
  const queue = Array.isArray(input) ? [...input] : undefined;
  return (buf: Uint8Array) => {
    const response = queue ? (queue.shift() ?? null) : input as string | null;
    if (response === null) return Promise.resolve(null);
    const encoded = encoder.encode(response);
    buf.set(encoded);
    return Promise.resolve(encoded.length);
  };
}

/**
 * Capture stderr and stdout writes into separate arrays and stub stdin to
 * return `input`.
 *
 * Note this stubs the async `write`, which is what the prompt helpers call.
 * The logger writes through `Deno.stderr.writeSync` (see `createStderrSink`
 * in infrastructure/logging/logger.ts) and so never reaches these captures.
 */
function stubIO(
  input: string | null | Array<string | null>,
  options?: { isTerminal?: boolean },
): {
  written: string[];
  stdoutWritten: string[];
  restore: () => void;
} {
  const written: string[] = [];
  const stdoutWritten: string[] = [];
  const decoder = new TextDecoder();
  const origStdoutWrite = Deno.stdout.write.bind(Deno.stdout);
  const origStderrWrite = Deno.stderr.write.bind(Deno.stderr);
  const origStdinRead = Deno.stdin.read.bind(Deno.stdin);
  const origIsTerminal = Deno.stdin.isTerminal.bind(Deno.stdin);

  Deno.stderr.write = (data: Uint8Array) => {
    written.push(decoder.decode(data));
    return Promise.resolve(data.length);
  };
  Deno.stdout.write = (data: Uint8Array) => {
    stdoutWritten.push(decoder.decode(data));
    return Promise.resolve(data.length);
  };
  Deno.stdin.read = fakeStdinRead(input);
  Deno.stdin.isTerminal = () => options?.isTerminal ?? true;

  return {
    written,
    stdoutWritten,
    restore() {
      Deno.stdout.write = origStdoutWrite;
      Deno.stderr.write = origStderrWrite;
      Deno.stdin.read = origStdinRead;
      Deno.stdin.isTerminal = origIsTerminal;
    },
  };
}

// ---------------------------------------------------------------------------
// promptLine
// ---------------------------------------------------------------------------

Deno.test("promptLine: returns trimmed user input", async () => {
  const io = stubIO("  hello world  \n");
  try {
    const result = await promptLine("Enter: ");
    assertEquals(result, "hello world");
    assertEquals(io.written, ["Enter: "]);
  } finally {
    io.restore();
  }
});

Deno.test("promptLine: returns empty string on EOF", async () => {
  const io = stubIO(null);
  try {
    const result = await promptLine("Enter: ");
    assertEquals(result, "");
  } finally {
    io.restore();
  }
});

// ---------------------------------------------------------------------------
// promptConfirmation
// ---------------------------------------------------------------------------

Deno.test("promptConfirmation: accepts 'y'", async () => {
  const io = stubIO("y\n");
  try {
    assertEquals(await promptConfirmation("Delete?"), true);
    assertEquals(io.written, ["Delete? [y/N] "]);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: accepts 'yes'", async () => {
  const io = stubIO("yes\n");
  try {
    assertEquals(await promptConfirmation("Delete?"), true);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: accepts 'Y' (case-insensitive)", async () => {
  const io = stubIO("Y\n");
  try {
    assertEquals(await promptConfirmation("Delete?"), true);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: accepts 'YES' (case-insensitive)", async () => {
  const io = stubIO("YES\n");
  try {
    assertEquals(await promptConfirmation("Delete?"), true);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: rejects 'n'", async () => {
  const io = stubIO("n\n");
  try {
    assertEquals(await promptConfirmation("Delete?"), false);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: rejects empty input", async () => {
  const io = stubIO("\n");
  try {
    assertEquals(await promptConfirmation("Delete?"), false);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: returns false on EOF", async () => {
  const io = stubIO(null);
  try {
    assertEquals(await promptConfirmation("Delete?"), false);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: rejects arbitrary text", async () => {
  const io = stubIO("yep\n");
  try {
    assertEquals(await promptConfirmation("Delete?"), false);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: throws UserError on non-interactive stdin", async () => {
  const io = stubIO("y\n", { isTerminal: false });
  try {
    const error = await assertRejects(
      () => promptConfirmation("Delete?"),
      UserError,
    );
    assertEquals(
      error.message,
      "stdin is not a terminal — use --yes (-y) to skip confirmation prompts non-interactively",
    );
  } finally {
    io.restore();
  }
});

// ---------------------------------------------------------------------------
// promptChoice
// ---------------------------------------------------------------------------

Deno.test("promptChoice: selects a numbered choice", async () => {
  const choices = ["alpha", "beta", "gamma"];
  const io = stubIO("2\n");
  try {
    const result = await promptChoice("Pick one:", choices);
    assertEquals(result, "beta");
    const output = io.written.join("");
    assertEquals(output.includes("1. alpha"), true);
    assertEquals(output.includes("2. beta"), true);
    assertEquals(output.includes("3. gamma"), true);
    assertEquals(output.includes("Other path"), false);
  } finally {
    io.restore();
  }
});

Deno.test("promptChoice: throws UserError on non-interactive stdin", async () => {
  const io = stubIO("2\n", { isTerminal: false });
  try {
    const error = await assertRejects(
      () => promptChoice("Pick:", ["alpha", "beta"]),
      UserError,
    );
    assertEquals(
      error.message,
      "stdin is not a terminal — use --yes (-y) to skip confirmation prompts non-interactively",
    );
  } finally {
    io.restore();
  }
});

Deno.test("promptChoice: falls back to first choice on empty input", async () => {
  const choices = ["alpha", "beta"];
  const io = stubIO("\n");
  try {
    const result = await promptChoice("Pick:", choices);
    assertEquals(result, "alpha");
  } finally {
    io.restore();
  }
});

// ---------------------------------------------------------------------------
// promptLineWithDefault
// ---------------------------------------------------------------------------

Deno.test("promptLineWithDefault: returns user input when provided", async () => {
  const io = stubIO("custom\n");
  try {
    const result = await promptLineWithDefault("Value:", "fallback");
    assertEquals(result, "custom");
    assertEquals(io.written, ["Value: (default: fallback) "]);
  } finally {
    io.restore();
  }
});

Deno.test("promptLineWithDefault: returns default on empty input", async () => {
  const io = stubIO("\n");
  try {
    const result = await promptLineWithDefault("Value:", "fallback");
    assertEquals(result, "fallback");
  } finally {
    io.restore();
  }
});

Deno.test("promptLineWithDefault: returns default on EOF", async () => {
  const io = stubIO(null);
  try {
    const result = await promptLineWithDefault("Value:", "fallback");
    assertEquals(result, "fallback");
  } finally {
    io.restore();
  }
});

// ---------------------------------------------------------------------------
// Stream discipline — swamp-club#2260
//
// Prompts go to stderr so a command whose stdout carries a value keeps that
// stream byte-exact under redirection. Before the fix, `swamp vault
// read-secret v k > key.pem` wrote the confirmation prompt into key.pem ahead
// of the secret.
// ---------------------------------------------------------------------------

Deno.test("promptLine: writes the prompt to stderr, never stdout", async () => {
  const io = stubIO("value\n");
  try {
    await promptLine("Enter: ");
    assertEquals(io.written, ["Enter: "]);
    assertEquals(io.stdoutWritten, []);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: writes the prompt to stderr, never stdout", async () => {
  const io = stubIO("y\n");
  try {
    await promptConfirmation("Delete?");
    assertEquals(io.written, ["Delete? [y/N] "]);
    assertEquals(io.stdoutWritten, []);
  } finally {
    io.restore();
  }
});

Deno.test("promptChoice: writes the menu and retry to stderr, never stdout", async () => {
  // "9" is out of range, so the menu is drawn twice and the invalid-choice
  // message is written between the two — every write on the retry path.
  const responses = ["9\n", "2\n"];
  const io = stubIO("");
  const encoder = new TextEncoder();
  Deno.stdin.read = (buf: Uint8Array) => {
    const encoded = encoder.encode(responses.shift() ?? "");
    buf.set(encoded);
    return Promise.resolve(encoded.length);
  };
  try {
    const result = await promptChoice("Pick one:", ["alpha", "beta"]);
    assertEquals(result, "beta");
    const stderr = io.written.join("");
    assertStringIncludes(stderr, "Pick one:");
    assertStringIncludes(stderr, "1. alpha");
    assertStringIncludes(stderr, "Invalid choice. Please enter 1-2.");
    assertEquals(io.stdoutWritten, []);
  } finally {
    io.restore();
  }
});

Deno.test("promptLineWithDefault: writes the prompt to stderr, never stdout", async () => {
  const io = stubIO("\n");
  try {
    await promptLineWithDefault("Value:", "fallback");
    assertEquals(io.written, ["Value: (default: fallback) "]);
    assertEquals(io.stdoutWritten, []);
  } finally {
    io.restore();
  }
});

// ---------------------------------------------------------------------------
// Consequence lines and numbered choices (swamp-club#2939)
// ---------------------------------------------------------------------------

Deno.test("promptConfirmation: prints the details above the question on stderr", async () => {
  const io = stubIO("n\n");
  try {
    assertEquals(
      await promptConfirmation("Push?", ["  y = push", "  N = exit"]),
      false,
    );
    assertEquals(io.written, ["  y = push\n", "  N = exit\n", "Push? [y/N] "]);
    assertEquals(io.stdoutWritten, []);
  } finally {
    io.restore();
  }
});

Deno.test("promptConfirmation: prints no details on a non-interactive stdin", async () => {
  const io = stubIO("y\n", { isTerminal: false });
  try {
    await assertRejects(
      () => promptConfirmation("Push?", ["  y = push"]),
      UserError,
      "stdin is not a terminal",
    );
    assertEquals(io.written, []);
  } finally {
    io.restore();
  }
});

Deno.test("promptNumberedChoice: returns the chosen index", async () => {
  const io = stubIO("2\n");
  try {
    assertEquals(
      await promptNumberedChoice(["Pick one."], ["Promote", "Bump", "Stop"]),
      1,
    );
    assertEquals(io.written, [
      "Pick one.\n",
      "  1. Promote\n",
      "  2. Bump\n",
      "  3. Stop\n",
      "Choose [1/2/3]: ",
    ]);
    assertEquals(io.stdoutWritten, []);
  } finally {
    io.restore();
  }
});

Deno.test("promptNumberedChoice: has no default; Enter and invalid answers ask again", async () => {
  const io = stubIO(["\n", "4\n", "x\n", "3\n"]);
  try {
    assertEquals(
      await promptNumberedChoice([], ["Promote", "Bump", "Stop"]),
      2,
    );
    assertEquals(
      io.written.filter((w) => w === "Choose [1/2/3]: ").length,
      4,
    );
    assertEquals(
      io.written.filter((w) => w === "Please enter 1, 2, 3.\n").length,
      3,
    );
  } finally {
    io.restore();
  }
});

Deno.test("promptNumberedChoice: returns null on EOF instead of asking forever", async () => {
  const io = stubIO(null);
  try {
    assertEquals(await promptNumberedChoice([], ["Promote", "Stop"]), null);
  } finally {
    io.restore();
  }
});

Deno.test("promptNumberedChoice: throws UserError on non-interactive stdin before printing", async () => {
  const io = stubIO("1\n", { isTerminal: false });
  try {
    await assertRejects(
      () => promptNumberedChoice(["Pick one."], ["Promote"]),
      UserError,
      "stdin is not a terminal",
    );
    assertEquals(io.written, []);
  } finally {
    io.restore();
  }
});
