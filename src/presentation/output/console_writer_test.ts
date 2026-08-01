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
import { setColorEnabled } from "@std/fmt/colors";
import {
  blankLine,
  contentLine,
  formatDuration,
  formatTimestamp,
  gutterLine,
  PipeWriter,
  renderDataBox,
} from "./console_writer.ts";

function noColor<T>(fn: () => T): T {
  setColorEnabled(false);
  try {
    return fn();
  } finally {
    setColorEnabled(true);
  }
}

Deno.test("formatTimestamp: formats UTC time", () => {
  const date = new Date("2026-07-15T23:43:45.000Z");
  assertEquals(formatTimestamp(date), "23:43:45 UTC");
});

Deno.test("formatTimestamp: zero-pads hours and minutes", () => {
  const date = new Date("2026-01-01T01:02:03.000Z");
  assertEquals(formatTimestamp(date), "01:02:03 UTC");
});

Deno.test("formatDuration: formats milliseconds", () => {
  assertEquals(formatDuration(42), "42ms");
  assertEquals(formatDuration(999), "999ms");
});

Deno.test("formatDuration: formats seconds", () => {
  assertEquals(formatDuration(1000), "1.0s");
  assertEquals(formatDuration(2300), "2.3s");
  assertEquals(formatDuration(59999), "60.0s");
});

Deno.test("formatDuration: formats minutes", () => {
  assertEquals(formatDuration(60000), "1m0s");
  assertEquals(formatDuration(90000), "1m30s");
});

Deno.test("gutterLine: right-pads status to gutter width", () => {
  noColor(() => {
    const line = gutterLine("Resolved", (s) => s, "my-server (terraform)");
    assertEquals(line, "   Resolved   my-server (terraform)");
  });
});

Deno.test("gutterLine: handles short status words", () => {
  noColor(() => {
    const line = gutterLine("Done", (s) => s, "step-1");
    assertEquals(line, "       Done   step-1");
  });
});

Deno.test("gutterLine: includes timestamp when provided", () => {
  noColor(() => {
    const line = gutterLine("Executing", (s) => s, "deploy", "23:43:45 UTC");
    assertEquals(line, "  Executing   deploy · 23:43:45 UTC");
  });
});

Deno.test("contentLine: indents to content column", () => {
  const line = contentLine("Initializing plugins...");
  assertEquals(line, "              Initializing plugins...");
});

Deno.test("blankLine: returns empty string", () => {
  assertEquals(blankLine(), "");
});

Deno.test("PipeWriter: pads names to longest", () => {
  noColor(() => {
    const pipe = new PipeWriter(["extract", "lint", "deploy"]);
    assertEquals(pipe.line("lint", "hello"), "    lint │ hello");
    assertEquals(pipe.line("extract", "hello"), " extract │ hello");
    assertEquals(pipe.line("deploy", "hello"), "  deploy │ hello");
  });
});

Deno.test("PipeWriter: updateWidth expands column", () => {
  noColor(() => {
    const pipe = new PipeWriter(["a", "bb"]);
    assertEquals(pipe.line("a", "x"), "  a │ x");
    pipe.updateWidth(["long-name"]);
    assertEquals(pipe.line("a", "x"), "         a │ x");
  });
});

Deno.test("PipeWriter.startLine: formats start with timestamp", () => {
  noColor(() => {
    const pipe = new PipeWriter(["extract"]);
    const line = pipe.startLine("extract", "23:43:45 UTC");
    assertEquals(line, " extract │ start 23:43:45 UTC");
  });
});

Deno.test("PipeWriter.startLine: includes suffix when provided", () => {
  noColor(() => {
    const pipe = new PipeWriter(["deploy"]);
    const line = pipe.startLine(
      "deploy",
      "23:43:45 UTC",
      "(depends on extract)",
    );
    assertEquals(line, " deploy │ start 23:43:45 UTC (depends on extract)");
  });
});

Deno.test("PipeWriter.doneLine: formats done with step path and duration", () => {
  noColor(() => {
    const pipe = new PipeWriter(["extract"]);
    const line = pipe.doneLine(
      "extract",
      "extract/fetch",
      "3.2s",
      "23:43:48 UTC",
    );
    assertEquals(line, " extract │ done extract/fetch in 3.2s · 23:43:48 UTC");
  });
});

Deno.test("PipeWriter.completedLine: formats completion", () => {
  noColor(() => {
    const pipe = new PipeWriter(["extract"]);
    const line = pipe.completedLine("extract", "3.6s", "23:43:49 UTC");
    assertEquals(line, " extract │ completed in 3.6s · 23:43:49 UTC");
  });
});

Deno.test("PipeWriter.failedStepLine: formats step failure in red", () => {
  noColor(() => {
    const pipe = new PipeWriter(["transform"]);
    const line = pipe.failedStepLine(
      "transform",
      "transform/map",
      "1.4s",
      "23:43:50 UTC",
    );
    assertEquals(
      line,
      " transform │ failed transform/map in 1.4s · 23:43:50 UTC",
    );
  });
});

Deno.test("PipeWriter.skippedLine: formats skip with reason", () => {
  noColor(() => {
    const pipe = new PipeWriter(["load"]);
    const line = pipe.skippedLine("load", "depends on transform");
    assertEquals(line, " load │ skipped (depends on transform)");
  });
});

Deno.test("PipeWriter.skippedLine: includes guard expression when provided", () => {
  noColor(() => {
    const pipe = new PipeWriter(["load"]);
    const line = pipe.skippedLine(
      "load",
      "guarded",
      'data.latest("checker", "result").attributes.exitCode == 0',
    );
    assertEquals(
      line,
      ' load │ skipped (guarded) · guard: data.latest("checker", "result").attributes.exitCode == 0',
    );
  });
});

Deno.test("PipeWriter.skippedLine: omits guard when not provided", () => {
  noColor(() => {
    const pipe = new PipeWriter(["load"]);
    const line = pipe.skippedLine("load", "guarded");
    assertEquals(line, " load │ skipped (guarded)");
  });
});

Deno.test("PipeWriter.stepLine: formats step with model and method", () => {
  noColor(() => {
    const pipe = new PipeWriter(["extract"]);
    const line = pipe.stepLine(
      "extract",
      "extract/fetch",
      "my-api",
      "extract",
      "23:43:45 UTC",
    );
    assertEquals(
      line,
      " extract │ step extract/fetch · my-api · extract · start 23:43:45 UTC",
    );
  });
});

Deno.test("PipeWriter.waitingLine: formats approval request", () => {
  noColor(() => {
    const pipe = new PipeWriter(["deploy"]);
    const line = pipe.waitingLine("deploy", "approval required");
    assertEquals(line, " deploy │ waiting approval required");
  });
});

Deno.test("renderDataBox: returns empty for no artifacts", () => {
  assertEquals(renderDataBox([]), []);
});

Deno.test("renderDataBox: renders artifact with attributes", () => {
  noColor(() => {
    const lines = renderDataBox([
      {
        name: "server-state",
        attributes: {
          ip_address: "203.0.113.42",
          region: "us-east-1",
        },
      },
    ]);
    assertEquals(lines.length > 0, true);
    const text = lines.join("\n");
    assertEquals(text.includes("Data produced"), true);
    assertEquals(text.includes("server-state"), true);
    assertEquals(text.includes("ip_address"), true);
    assertEquals(text.includes("203.0.113.42"), true);
    assertEquals(text.includes("region"), true);
    assertEquals(text.includes("us-east-1"), true);
  });
});

Deno.test("renderDataBox: truncates at 10 keys", () => {
  noColor(() => {
    const attrs: Record<string, unknown> = {};
    for (let i = 0; i < 14; i++) {
      attrs[`key${i}`] = `val${i}`;
    }
    const lines = renderDataBox([{ name: "big", attributes: attrs }]);
    const text = lines.join("\n");
    assertEquals(text.includes("key0"), true);
    assertEquals(text.includes("key9"), true);
    assertEquals(text.includes("+4 more"), true);
  });
});

Deno.test("renderDataBox: handles nested values", () => {
  noColor(() => {
    const lines = renderDataBox([
      {
        name: "test",
        attributes: {
          array: [1, 2, 3],
          object: { nested: true },
          nil: null,
        },
      },
    ]);
    const text = lines.join("\n");
    assertEquals(text.includes("3 items"), true);
    assertEquals(text.includes("object"), true);
    assertEquals(text.includes("null"), true);
  });
});

Deno.test("renderDataBox: renders artifact source", () => {
  noColor(() => {
    const lines = renderDataBox([
      { name: "api-records", source: "extract[0]", attributes: { count: 42 } },
    ]);
    const text = lines.join("\n");
    assertEquals(text.includes("from extract[0]"), true);
  });
});
