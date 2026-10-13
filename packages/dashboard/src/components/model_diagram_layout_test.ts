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
import {
  anchorY,
  BOX_H,
  charsThatFit,
  curve,
  type DiagramGroup,
  type DiagramGroupKey,
  type DiagramNode,
  type DiagramSpec,
  frameLabel,
  layoutDiagram,
  type Rect,
  truncate,
  visibleNodes,
} from "./model_diagram_layout.ts";

function nodes(prefix: string, n: number): DiagramNode[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    label: `${prefix}${i}`,
    kind: "argument",
    to: null,
  }));
}

function spec(
  counts: Partial<Record<DiagramGroupKey, number>>,
  extension: DiagramSpec["extension"] = null,
): DiagramSpec {
  const groups: DiagramGroup[] = [];
  const add = (key: DiagramGroupKey, side: "in" | "out") => {
    const n = counts[key];
    if (n !== undefined) {
      groups.push({ key, title: key, side, nodes: nodes(key, n) });
    }
  };
  add("arguments", "in");
  add("methods", "in");
  add("outputs", "out");
  add("reports", "out");
  return { model: { name: "m", type: "command/shell" }, groups, extension };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h &&
    b.y < a.y + a.h;
}

Deno.test("truncate: keeps short text and cuts long text with an ellipsis", () => {
  assertEquals(truncate("short", 10), "short");
  assertEquals(truncate("abcdefghij", 10), "abcdefghij");
  assertEquals(truncate("abcdefghijk", 10), "abcdefghi…");
  assertEquals(truncate("abc", 1), "…");
});

Deno.test("charsThatFit: never returns less than one character", () => {
  assertEquals(charsThatFit(73, 7.3), 10);
  assertEquals(charsThatFit(2, 7.3), 1);
});

Deno.test("visibleNodes: shows everything up to the cap", () => {
  const v = visibleNodes(nodes("a", 6), 6, false);
  assertEquals(v.shown.length, 6);
  assertEquals(v.hidden, 0);
  assertEquals(v.collapsible, false);
});

Deno.test("visibleNodes: over the cap folds the rest behind a toggle", () => {
  const v = visibleNodes(nodes("a", 10), 6, false);
  assertEquals(v.shown.length, 5);
  assertEquals(v.hidden, 5);
  assertEquals(v.collapsible, true);
});

Deno.test("visibleNodes: expanded shows every node and stays collapsible", () => {
  const v = visibleNodes(nodes("a", 10), 6, true);
  assertEquals(v.shown.length, 10);
  assertEquals(v.hidden, 0);
  assertEquals(v.collapsible, true);
});

Deno.test("frameLabel: names the version or marks an inferred scope", () => {
  assertEquals(
    frameLabel({ name: "@acme/aws", version: "1.2.0", inferred: false }),
    "@acme/aws · v1.2.0",
  );
  assertEquals(frameLabel({ name: "@acme/aws", inferred: false }), "@acme/aws");
  assertEquals(
    frameLabel({ name: "@acme/aws", inferred: true }),
    "@acme/aws · inferred",
  );
});

Deno.test("curve: draws a cubic from start to end", () => {
  assertEquals(curve(0, 0, 100, 50), "M0 0 C50 0 50 50 100 50");
});

Deno.test("anchorY: spreads edges across the middle of the model's side", () => {
  const model = { x: 0, y: 0, w: 100, h: 100 };
  assertEquals(anchorY(model, 0, 1), 50);
  const ys = [0, 1, 2].map((i) => anchorY(model, i, 3));
  assertEquals(ys[1], 50);
  assert(ys[0] < ys[1] && ys[1] < ys[2]);
  assert(ys[0] >= 20 && ys[2] <= 80);
});

Deno.test("layoutDiagram: horizontal puts inputs left, model centre, outputs right", () => {
  const l = layoutDiagram(spec({ arguments: 3, outputs: 2, reports: 1 }), {
    orientation: "horizontal",
  });
  const ins = l.boxes.filter((b) => b.side === "in");
  const outs = l.boxes.filter((b) => b.side === "out");
  assertEquals(ins.length, 3);
  assertEquals(outs.length, 3);
  for (const b of ins) assert(b.x + b.w < l.model.x);
  for (const b of outs) assert(b.x > l.model.x + l.model.w);
  assertEquals(l.edges.length, 6);
  assertEquals(l.headings.map((h) => h.group), [
    "arguments",
    "outputs",
    "reports",
  ]);
  assertEquals(l.frame, null);
});

Deno.test("layoutDiagram: boxes never overlap and stay inside the canvas", () => {
  for (const orientation of ["horizontal", "vertical"] as const) {
    const l = layoutDiagram(
      spec({ arguments: 9, methods: 3, outputs: 12, reports: 4 }, {
        name: "@acme/aws",
        inferred: true,
      }),
      { orientation, expanded: new Set(["outputs"]) },
    );
    const rects: Rect[] = [...l.boxes, ...l.toggles, l.model];
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      assert(a.x >= 0 && a.y >= 0, `${orientation}: inside`);
      assert(a.x + a.w <= l.width && a.y + a.h <= l.height);
      for (let j = i + 1; j < rects.length; j++) {
        assert(!overlaps(a, rects[j]), `${orientation}: ${i} overlaps ${j}`);
      }
    }
  }
});

Deno.test("layoutDiagram: caps each group and adds a '+N more' toggle", () => {
  const l = layoutDiagram(spec({ arguments: 2, outputs: 20 }), {
    orientation: "horizontal",
    maxPerGroup: 6,
  });
  assertEquals(l.boxes.filter((b) => b.group === "outputs").length, 5);
  assertEquals(l.toggles.length, 1);
  assertEquals(l.toggles[0].label, "+15 more");
  assertEquals(l.toggles[0].expanded, false);
});

Deno.test("layoutDiagram: an expanded group shows every box and 'Show fewer'", () => {
  const l = layoutDiagram(spec({ outputs: 20 }), {
    orientation: "horizontal",
    maxPerGroup: 6,
    expanded: new Set(["outputs"]),
  });
  assertEquals(l.boxes.filter((b) => b.group === "outputs").length, 20);
  assertEquals(l.toggles[0].label, "Show fewer");
  assert(l.height > 20 * BOX_H);
});

Deno.test("layoutDiagram: the extension frame wraps the model with room for its caption", () => {
  const l = layoutDiagram(
    spec({ arguments: 1, outputs: 1 }, {
      name: "@acme/aws",
      version: "2.0.0",
      inferred: false,
    }),
    { orientation: "horizontal" },
  );
  const f = l.frame!;
  assert(f.x < l.model.x && f.y < l.model.y);
  assert(f.x + f.w > l.model.x + l.model.w);
  assert(f.y + f.h > l.model.y + l.model.h);
  assert(f.labelY < l.model.y);
  assertEquals(f.label, "@acme/aws · v2.0.0");
});

Deno.test("layoutDiagram: long names are truncated to fit and flagged", () => {
  const long = "a-really-long-data-output-name-that-cannot-fit-in-a-box";
  const s = spec({ outputs: 0 });
  s.groups[0].nodes.push({ id: "x", label: long, kind: "resource", to: null });
  s.model.name = long + long;
  const l = layoutDiagram(s, { orientation: "horizontal" });
  const box = l.boxes[0];
  assert(box.label.endsWith("…"));
  assert(box.label.length < long.length);
  assert(box.truncated);
  assert(l.model.name.endsWith("…"));
  assert(l.model.nameTruncated);
});

Deno.test("layoutDiagram: vertical stacks inputs above and outputs below the model", () => {
  const l = layoutDiagram(spec({ arguments: 2, outputs: 2 }), {
    orientation: "vertical",
  });
  assert(l.width < 400);
  for (const b of l.boxes.filter((b) => b.side === "in")) {
    assert(b.y + b.h < l.model.y);
  }
  for (const b of l.boxes.filter((b) => b.side === "out")) {
    assert(b.y > l.model.y + l.model.h);
  }
  assertEquals(l.edges.length, 4);
});

Deno.test("layoutDiagram: a group of placeholders draws muted edges", () => {
  const s = spec({ outputs: 0 });
  s.groups[0].nodes.push({
    id: "none",
    label: "No outputs yet",
    kind: "placeholder",
    to: null,
  });
  const l = layoutDiagram(s, { orientation: "horizontal" });
  assertEquals(l.edges[0].muted, true);
  assertEquals(l.headings[0].count, 0);
});
