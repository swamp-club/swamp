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

import { assert, assertEquals } from "@std/assert";
import { unicodeWidth } from "@std/cli/unicode-width";
import { getColorEnabled, setColorEnabled } from "@std/fmt/colors";
import {
  blankLine,
  contentLine,
  formatDuration,
  formatTimestamp,
  gutterLine,
  isUserFacingArtifact,
  PipeWriter,
  renderDataBox,
  STATUS_COLORS,
} from "./console_writer.ts";
import { interactiveFormatter } from "../../infrastructure/logging/log_format.ts";
import {
  SUMMARY_DISPLAY_HIDDEN,
  SUMMARY_DISPLAY_TAG,
} from "../../domain/data/data.ts";

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

Deno.test("interactiveFormatter: log records line up with gutter and pipe lines", () => {
  const record = {
    category: ["model", "loader"],
    level: "warning" as const,
    message: ["Using ", "deno.json", ""],
    rawMessage: "Using {}",
    timestamp: 0,
    properties: {},
  };
  const pipeState: { width?: number } = {};
  const format = interactiveFormatter({
    showCategory: false,
    showProperties: false,
    getPipeWidth: () => pipeState.width,
  });
  assertEquals(
    format(record),
    `${gutterLine("Warning", STATUS_COLORS.warn, "Using deno.json")}\n`,
  );
  const pipe = new PipeWriter(["create-vpc", "system"]);
  pipeState.width = pipe.maxWidth;
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  assertEquals(
    format(record).replace(ansi, ""),
    `${
      pipe.statusLine(
        "system",
        "Warning",
        STATUS_COLORS.warn,
        "Using deno.json",
      )
    }\n`.replace(ansi, ""),
  );
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

Deno.test("PipeWriter.failedStepLine: omits the duration of a step that never started", () => {
  noColor(() => {
    const pipe = new PipeWriter(["main"]);
    assertEquals(
      pipe.failedStepLine("main", "deploy-b", "", "23:43:50 UTC"),
      " main │ failed deploy-b · 23:43:50 UTC",
    );
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

Deno.test("PipeWriter.skippedStepLine: names the step before the reason", () => {
  noColor(() => {
    const pipe = new PipeWriter(["main"]);
    const line = pipe.skippedStepLine("main", "rollback", "dependency");
    assertEquals(line, " main │ skipped rollback (dependency)");
  });
});

Deno.test("PipeWriter.skippedStepLine: includes guard expression when provided", () => {
  noColor(() => {
    const pipe = new PipeWriter(["main"]);
    const line = pipe.skippedStepLine(
      "main",
      "cleanup",
      "guarded",
      'data.latest("checker", "result").attributes.exitCode == 0',
    );
    assertEquals(
      line,
      ' main │ skipped cleanup (guarded) · guard: data.latest("checker", "result").attributes.exitCode == 0',
    );
  });
});

Deno.test("PipeWriter.skippedStepLine: omits the reason when not provided", () => {
  noColor(() => {
    const pipe = new PipeWriter(["main"]);
    const line = pipe.skippedStepLine("main", "rollback");
    assertEquals(line, " main │ skipped rollback");
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

Deno.test("renderDataBox: prints the data query hint below the box, keeping its edge intact", () => {
  noColor(() => {
    const attrs: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      attrs[`key${i}`] = `val${i}`;
    }
    const lines = renderDataBox([{ name: "system-info", attributes: attrs }], {
      modelName: "my-server",
    });
    const bottom = lines.findIndex((line) => line.trimStart().startsWith("└"));
    assertEquals(
      lines.slice(bottom + 1),
      [
        `  → swamp data query 'modelName == "my-server" && name == "system-info"' --select content`,
      ],
    );
    for (const line of lines.slice(0, bottom + 1)) {
      assertEquals(line.length <= lines[bottom].length, true, line);
    }
  });
});

Deno.test("isUserFacingArtifact: hides reports, logs and display-hidden data", () => {
  assertEquals(isUserFacingArtifact({ name: "result" }), true);
  assertEquals(isUserFacingArtifact({ name: "result", tags: {} }), true);
  assertEquals(isUserFacingArtifact({ name: "report-summary" }), false);
  assertEquals(isUserFacingArtifact({ name: "log" }), false);
  assertEquals(
    isUserFacingArtifact({
      name: "result",
      tags: { [SUMMARY_DISPLAY_TAG]: SUMMARY_DISPLAY_HIDDEN },
    }),
    false,
  );
  assertEquals(
    isUserFacingArtifact({
      name: "result",
      tags: { [SUMMARY_DISPLAY_TAG]: "shown" },
    }),
    true,
  );
});

// deno-lint-ignore no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

function boxWidths(lines: string[]): number[] {
  const plain = lines.map((line) => line.replace(SGR, ""));
  const top = plain.findIndex((line) => line.trimStart().startsWith("┌"));
  const bottom = plain.findIndex((line) => line.trimStart().startsWith("└"));
  return plain.slice(top, bottom + 1).map((line) => unicodeWidth(line));
}

function assertBoxAligned(lines: string[]): void {
  const widths = boxWidths(lines);
  assertEquals(new Set(widths).size, 1, lines.join("\n"));
  assert(widths[0] <= 86, lines.join("\n"));
}

Deno.test("renderDataBox: an argument row under a long key fits the box", () => {
  noColor(() => {
    const lines = renderDataBox([], {
      globalArguments: {
        releaseAuthors: "x".repeat(100),
        mergeMethod: "squash",
      },
    });
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("x...")), true);
  });
});

Deno.test("renderDataBox: an attribute row under a long key fits the box", () => {
  noColor(() => {
    const lines = renderDataBox([
      { name: "d", attributes: { aVeryLongKeyName: "y".repeat(100) } },
    ]);
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("y...")), true);
  });
});

Deno.test("renderDataBox: a long artifact header is cut to fit the box", () => {
  noColor(() => {
    const lines = renderDataBox([
      { name: "n".repeat(60), source: "s".repeat(40), attributes: { a: 1 } },
    ]);
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("from sss")), true);
  });
});

Deno.test("renderDataBox: wide characters are measured by display width", () => {
  noColor(() => {
    const lines = renderDataBox([], {
      globalArguments: { k: "日本語テキスト🎉" },
    });
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("日本語テキスト🎉")), true);
  });
});

Deno.test("renderDataBox: a wide-character key pads the key column by display width", () => {
  noColor(() => {
    const lines = renderDataBox([], {
      globalArguments: { "名前": "alpha", region: "beta" },
    });
    assertBoxAligned(lines);
    const column = (value: string) => {
      const line = lines.find((l) => l.includes(value))!;
      return unicodeWidth(line.slice(0, line.indexOf(value)));
    };
    assertEquals(column("alpha"), column("beta"));
  });
});

Deno.test("renderDataBox: a wide character straddling the cut is dropped and the row still fits", () => {
  noColor(() => {
    const lines = renderDataBox([], {
      globalArguments: { k: "語".repeat(50) },
    });
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("語...")), true);
  });
});

Deno.test("renderDataBox: a key wider than the box is cut with an ellipsis", () => {
  noColor(() => {
    const lines = renderDataBox([], {
      globalArguments: { ["k".repeat(100)]: "value" },
    });
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("k...")), true);
    assertEquals(lines.some((line) => line.includes("value")), false);
  });
});

Deno.test("renderDataBox: a multi-line value shows its first line and an ellipsis", () => {
  noColor(() => {
    const lines = renderDataBox([], {
      globalArguments: { script: "line one\nline two" },
    });
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("line one...")), true);
    assertEquals(lines.some((line) => line.includes("line two")), false);
  });
});

Deno.test("renderDataBox: color codes inside a value are dropped and the row fits", () => {
  noColor(() => {
    const lines = renderDataBox([
      {
        name: "out",
        attributes: { stdout: `\x1b[31m${"r".repeat(100)}\x1b[0m` },
      },
    ]);
    assertBoxAligned(lines);
    assertEquals(lines.some((line) => line.includes("\x1b")), false);
  });
});

Deno.test("renderDataBox: a cut row with colors enabled leaves no style open at the border", () => {
  const enabled = getColorEnabled();
  setColorEnabled(true);
  try {
    const lines = renderDataBox([], {
      globalArguments: { releaseAuthors: "x".repeat(100) },
    });
    assertBoxAligned(lines);
    const sideEnd = "\x1b[2m│\x1b[22m";
    for (const line of lines.filter((l) => l.endsWith(sideEnd))) {
      let open = 0;
      for (const [code] of line.slice(0, -sideEnd.length).matchAll(SGR)) {
        if (code === "\x1b[1m" || code === "\x1b[2m") open++;
        if (code === "\x1b[22m") open = 0;
      }
      assertEquals(open, 0, JSON.stringify(line));
    }
  } finally {
    setColorEnabled(enabled);
  }
});
