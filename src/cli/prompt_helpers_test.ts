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
  promptChoice,
  promptConfirmation,
  promptLine,
  promptLineWithDefault,
} from "./prompt_helpers.ts";

// ---------------------------------------------------------------------------
// Test helpers — stub Deno.stdin.read and Deno.stdout.write so the prompt
// functions can be tested without a real TTY.
// ---------------------------------------------------------------------------

function fakeStdinRead(
  response: string | null,
): (buf: Uint8Array) => Promise<number | null> {
  const encoder = new TextEncoder();
  return (buf: Uint8Array) => {
    if (response === null) return Promise.resolve(null);
    const encoded = encoder.encode(response);
    buf.set(encoded);
    return Promise.resolve(encoded.length);
  };
}

/** Capture stdout writes into a string array and stub stdin to return `input`. */
function stubIO(input: string | null): {
  written: string[];
  restore: () => void;
} {
  const written: string[] = [];
  const decoder = new TextDecoder();
  const origStdoutWrite = Deno.stdout.write.bind(Deno.stdout);
  const origStdinRead = Deno.stdin.read.bind(Deno.stdin);

  Deno.stdout.write = (data: Uint8Array) => {
    written.push(decoder.decode(data));
    return Promise.resolve(data.length);
  };
  Deno.stdin.read = fakeStdinRead(input);

  return {
    written,
    restore() {
      Deno.stdout.write = origStdoutWrite;
      Deno.stdin.read = origStdinRead;
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

// ---------------------------------------------------------------------------
// promptChoice
// ---------------------------------------------------------------------------

Deno.test("promptChoice: selects a numbered choice", async () => {
  const choices = ["alpha", "beta", "gamma"];
  // Simulate user typing "2" to pick "beta"
  const io = stubIO("2\n");
  try {
    const result = await promptChoice("Pick one:", choices);
    assertEquals(result, "beta");
    // Verify it printed the menu
    const output = io.written.join("");
    assertEquals(output.includes("1. alpha"), true);
    assertEquals(output.includes("2. beta"), true);
    assertEquals(output.includes("3. gamma"), true);
    assertEquals(output.includes("4. Other path"), true);
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
