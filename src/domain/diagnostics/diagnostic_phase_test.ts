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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  currentDiagnosticArea,
  currentDiagnosticTally,
  diagnosticSpanAttributes,
  observeDiagnosticPhase,
  outsideDiagnosticArea,
  PhaseTally,
  startDiagnosticPhase,
  utf8ByteLength,
  withDiagnosticArea,
  withDiagnosticAttributes,
} from "./diagnostic_phase.ts";
import {
  type ExecutionObserver,
  setExecutionObserver,
} from "../remote/observability.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  withCapturedSpans,
  withObservedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";

Deno.test("startDiagnosticPhase: exports nothing outside an area", async () => {
  await withObservedSpans(async (spans) => {
    const phase = startDiagnosticPhase("definition_lookup");
    phase.tally.add("files_read", 3);
    phase.end();
    await observeDiagnosticPhase("lock_wait", {}, () => Promise.resolve());
    assertEquals(phase.recording, false);
    assertEquals(spans.length, 0);
  });
});

Deno.test("startDiagnosticPhase: exports area, phase, tally and outcome", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("enrollment", () => {
      const phase = startDiagnosticPhase("definition_scan", {
        "swamp.diagnostic.scan_root": "auto",
      });
      assert(phase.recording);
      phase.tally.add("files_read", 2);
      phase.tally.add("files_read");
      phase.end();
      phase.end("error");
      return Promise.resolve();
    });
    const span = findSpan(spans, "swamp.diagnostic.definition_scan");
    assertEquals(span.attributes["swamp.diagnostic.area"], "enrollment");
    assertEquals(span.attributes["swamp.diagnostic.phase"], "definition_scan");
    assertEquals(span.attributes["swamp.diagnostic.scan_root"], "auto");
    assertEquals(span.attributes["swamp.diagnostic.files_read"], 3);
    assertEquals(span.attributes["swamp.outcome"], "ok");
    assertEquals(typeof span.attributes["swamp.phase.uncovered_ms"], "number");
  });
});

Deno.test("startDiagnosticPhase: an area exports the shared phases and only its own", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("step_outputs", () => {
      startDiagnosticPhase("prepare").end();
      startDiagnosticPhase("definition_lookup").end();
      return Promise.resolve();
    });
    assertEquals(diagnosticPhases(spans, "prepare").length, 0);
    const lookup = findSpan(spans, "swamp.diagnostic.definition_lookup");
    assertEquals(lookup.attributes["swamp.diagnostic.area"], "step_outputs");
  });
});

Deno.test("observeDiagnosticPhase: nests children and ends a failed phase with its outcome", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("enrollment", async () => {
      await assertRejects(() =>
        observeDiagnosticPhase("prepare", {}, async () => {
          await observeDiagnosticPhase(
            "type_resolution",
            {},
            () => Promise.resolve(),
          );
          throw new DOMException("stopped", "AbortError");
        })
      );
    });
    const prepare = findSpan(spans, "swamp.diagnostic.prepare");
    const resolution = findSpan(spans, "swamp.diagnostic.type_resolution");
    assert(isChildOf(resolution, prepare));
    assertEquals(prepare.attributes["swamp.outcome"], "cancelled");
    assertEquals(resolution.attributes["swamp.outcome"], "ok");
  });
});

Deno.test("withDiagnosticAttributes: labels every phase started inside it", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("enrollment", async () => {
      await withDiagnosticAttributes(
        { "swamp.diagnostic.lookup_attempt": "recheck" },
        () =>
          observeDiagnosticPhase("definition_lookup", {}, async () => {
            await observeDiagnosticPhase(
              "definition_scan",
              {},
              () => Promise.resolve(),
            );
          }),
      );
      await observeDiagnosticPhase("lock_held", {}, () => Promise.resolve());
    });
    for (const name of ["definition_lookup", "definition_scan"]) {
      assertEquals(
        findSpan(spans, `swamp.diagnostic.${name}`)
          .attributes["swamp.diagnostic.lookup_attempt"],
        "recheck",
      );
    }
    assertEquals(
      findSpan(spans, "swamp.diagnostic.lock_held")
        .attributes["swamp.diagnostic.lookup_attempt"],
      undefined,
    );
  });
});

Deno.test("withDiagnosticArea: each phase records whether the operation was seen cancelled", async () => {
  await withObservedSpans(async (spans) => {
    const controller = new AbortController();
    await withDiagnosticArea("enrollment", async () => {
      await observeDiagnosticPhase("prepare", {}, () => Promise.resolve());
      controller.abort();
      await observeDiagnosticPhase(
        "registry_load",
        {},
        () => Promise.resolve(),
      );
    }, controller.signal);
    assertEquals(
      findSpan(spans, "swamp.diagnostic.prepare")
        .attributes["swamp.diagnostic.cancel_observed"],
      false,
    );
    assertEquals(
      findSpan(spans, "swamp.diagnostic.registry_load")
        .attributes["swamp.diagnostic.cancel_observed"],
      true,
    );
  });
});

Deno.test("currentDiagnosticTally: measures into the innermost running phase", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("enrollment", async () => {
      await observeDiagnosticPhase("definition_scan", {}, async (scan) => {
        await scan.tally.measure("read", async () => {
          // A layer below, reached through a closure, measures into the
          // same tally; that time leaves the outer measurement.
          await currentDiagnosticTally().measure(
            "parse",
            () => Promise.resolve(),
          );
          currentDiagnosticTally().add("files_read");
        });
      });
    });
    const scan = findSpan(spans, "swamp.diagnostic.definition_scan");
    assertEquals(scan.attributes["swamp.diagnostic.files_read"], 1);
    assertEquals(
      typeof scan.attributes["swamp.diagnostic.parse_work_ms"],
      "number",
    );
    assertEquals(
      typeof scan.attributes["swamp.diagnostic.read_work_ms"],
      "number",
    );
  });
});

Deno.test("PhaseTally.measure: a nested measurement is excluded from the outer one", async () => {
  let now = 0;
  const original = performance.now;
  performance.now = () => now;
  try {
    const tally = new PhaseTally(true);
    await tally.measure("outer", async () => {
      now += 5;
      await tally.measure("inner", () => {
        now += 20;
        return Promise.resolve();
      });
      now += 1;
    });
    assertEquals(tally.attributes(), {
      "swamp.diagnostic.outer_work_ms": 6,
      "swamp.diagnostic.inner_work_ms": 20,
    });
  } finally {
    performance.now = original;
  }
});

Deno.test("PhaseTally.measure: concurrent measurements each add their own time, whichever ends first", async () => {
  let now = 0;
  const original = performance.now;
  performance.now = () => now;
  try {
    const tally = new PhaseTally(true);
    const other = new PhaseTally(true);
    const { promise: aDone, resolve: endA } = Promise.withResolvers<void>();
    const { promise: bDone, resolve: endB } = Promise.withResolvers<void>();
    const a = tally.measure("read", () => aDone);
    now = 2;
    const b = tally.measure("read", () => bDone);
    now = 5;
    endB();
    await b;
    now = 10;
    endA();
    await a;
    // A later measurement has no stale parent to hide its time in.
    await tally.measure("parse", async () => {
      now += 4;
      // Another tally's measurement is not nested in this one.
      await other.measure("lookup", () => {
        now += 3;
        return Promise.resolve();
      });
    });
    assertEquals(tally.attributes(), {
      "swamp.diagnostic.read_work_ms": 13,
      "swamp.diagnostic.parse_work_ms": 7,
    });
    assertEquals(other.attributes(), {
      "swamp.diagnostic.lookup_work_ms": 3,
    });
  } finally {
    performance.now = original;
  }
});

Deno.test("PhaseTally: a tally that is not recording keeps nothing", async () => {
  const tally = new PhaseTally(false);
  tally.add("files");
  assertEquals(await tally.measure("read", () => Promise.resolve(7)), 7);
  assertEquals(tally.attributes(), {});
});

Deno.test("startDiagnosticPhase: an unsampled phase is silent", async () => {
  // No execution observer: observations are silent, so nothing records.
  await withCapturedSpans(async (spans) => {
    await withDiagnosticArea("enrollment", () => {
      const phase = startDiagnosticPhase("definition_scan");
      assertEquals(phase.recording, false);
      phase.tally.add("files_read");
      phase.end();
      return Promise.resolve();
    });
    assertEquals(spans.length, 0);
  });
});

Deno.test("withDiagnosticArea: phases started after the area returns are silent", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("enrollment", () => Promise.resolve());
    assertEquals(currentDiagnosticArea(), undefined);
    startDiagnosticPhase("prepare").end();
    assertEquals(diagnosticPhases(spans, "prepare").length, 0);
  });
});

Deno.test("utf8ByteLength: matches TextEncoder", () => {
  for (const text of ["", "abc", "é", "€uro", "😀x", "\ud800", "a\udc00"]) {
    assertEquals(
      utf8ByteLength(text),
      new TextEncoder().encode(text).length,
      JSON.stringify(text),
    );
  }
});

Deno.test("startDiagnosticPhase: an observer that throws never changes the work's result or error", async () => {
  const throwing = () => {
    throw new Error("exporter broke");
  };
  const breakingAt = (
    stage: "start" | "attributes" | "end",
  ): ExecutionObserver => ({
    start: () => {
      if (stage === "start") throwing();
      return {
        carrier: undefined,
        recording: true,
        run: (fn) => fn(),
        attributes: stage === "attributes" ? throwing : () => {},
        end: stage === "end" ? throwing : () => {},
      };
    },
  });
  for (const stage of ["start", "attributes", "end"] as const) {
    setExecutionObserver(breakingAt(stage));
    try {
      await withDiagnosticArea("enrollment", async () => {
        assertEquals(
          await observeDiagnosticPhase("definition_lookup", {}, (phase) => {
            phase.attributes({ "swamp.diagnostic.hit": true });
            phase.tally.add("files_read");
            return Promise.resolve(42);
          }),
          42,
          stage,
        );
        const failure = new Error("lookup failed");
        const thrown = await assertRejects(() =>
          observeDiagnosticPhase(
            "definition_lookup",
            {},
            () => Promise.reject(failure),
          )
        );
        assertEquals(thrown, failure, stage);
      });
    } finally {
      setExecutionObserver(undefined);
    }
  }
});

Deno.test("startDiagnosticPhase: output retention exports its own phases and gate_wait", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("output_retention", () => {
      startDiagnosticPhase("candidate_scan").end();
      startDiagnosticPhase("gate_wait").end();
      startDiagnosticPhase("prepare").end();
      return Promise.resolve();
    });
    await withDiagnosticArea("enrollment", () => {
      startDiagnosticPhase("candidate_scan").end();
      return Promise.resolve();
    });
    const scan = findSpan(spans, "swamp.diagnostic.candidate_scan");
    assertEquals(scan.attributes["swamp.diagnostic.area"], "output_retention");
    assertEquals(diagnosticPhases(spans, "gate_wait").length, 1);
    assertEquals(diagnosticPhases(spans, "prepare").length, 0);
  });
});

Deno.test("diagnosticSpanAttributes: tags a span as a phase only inside an area that exports it", async () => {
  assertEquals(diagnosticSpanAttributes("gate_wait"), {});
  await withDiagnosticArea(
    "output_retention",
    () =>
      withDiagnosticAttributes({ "swamp.diagnostic.label": "x" }, () => {
        assertEquals(diagnosticSpanAttributes("gate_wait"), {
          "swamp.diagnostic.label": "x",
          "swamp.diagnostic.area": "output_retention",
          "swamp.diagnostic.phase": "gate_wait",
        });
        assertEquals(diagnosticSpanAttributes("prepare"), {});
        return Promise.resolve();
      }),
  );
});

// Shared additions used by the access_poll area (swamp-club#4005).

Deno.test("startDiagnosticPhase: the access_poll area exports its own phases and not another area's", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("access_poll", () => {
      startDiagnosticPhase("poll_cycle").end();
      startDiagnosticPhase("gate_wait").end();
      startDiagnosticPhase("prepare").end();
      return Promise.resolve();
    });
    await withDiagnosticArea("enrollment", () => {
      startDiagnosticPhase("poll_cycle").end();
      return Promise.resolve();
    });
    const [cycle] = diagnosticPhases(spans, "poll_cycle");
    assertEquals(diagnosticPhases(spans, "poll_cycle").length, 1);
    assertEquals(cycle.attributes["swamp.diagnostic.area"], "access_poll");
    assertEquals(diagnosticPhases(spans, "gate_wait").length, 1);
    assertEquals(diagnosticPhases(spans, "prepare").length, 0);
  });
});

Deno.test("DiagnosticPhaseHandle.result: records what the phase achieved, apart from its outcome", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea("access_poll", () => {
      const phase = startDiagnosticPhase("poll_cycle");
      phase.result("no_change");
      phase.end();
      return Promise.resolve();
    });
    const phase = startDiagnosticPhase("poll_cycle");
    phase.result("applied");
    phase.end();
    const [span] = diagnosticPhases(spans, "poll_cycle");
    assertEquals(diagnosticPhases(spans, "poll_cycle").length, 1);
    assertEquals(span.attributes["swamp.diagnostic.result"], "no_change");
    assertEquals(span.attributes["swamp.outcome"], "ok");
  });
});

Deno.test("outsideDiagnosticArea: work scheduled from inside an area carries no area", async () => {
  await withObservedSpans(async (spans) => {
    let inside: string | undefined;
    let outside: string | undefined = "unset";
    await withDiagnosticArea("access_poll", async () => {
      inside = currentDiagnosticArea();
      await new Promise<void>((resolve) =>
        outsideDiagnosticArea(() =>
          setTimeout(() => {
            outside = currentDiagnosticArea();
            startDiagnosticPhase("snapshot_build").end();
            resolve();
          }, 0)
        )
      );
    });
    assertEquals(inside, "access_poll");
    assertEquals(outside, undefined);
    assertEquals(diagnosticPhases(spans, "snapshot_build").length, 0);
  });
});
