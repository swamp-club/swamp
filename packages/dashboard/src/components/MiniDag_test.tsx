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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { MiniDag } from "./MiniDag.tsx";

const nodes = [
  { id: "build", label: "build" },
  { id: "approve", label: "approve", status: "suspended" },
  { id: "deploy", label: "deploy", status: "waiting" },
  { id: "docs", label: "docs" },
];
const edges = [
  { from: "build", to: "approve" },
  { from: "approve", to: "deploy" },
  { from: "build", to: "docs" },
];

Deno.test("MiniDag: renders a node per job and an edge per dependency", () => {
  const html = renderToStaticMarkup(
    <MiniDag nodes={nodes} edges={edges} label="Jobs of release" />,
  );
  assertStringIncludes(html, 'aria-label="Jobs of release"');
  assertEquals(html.match(/class="mini-dag-node /g)?.length, 4);
  assertEquals(html.match(/class="mini-dag-edge[" ]/g)?.length, 3);
  assertStringIncludes(html, "tone-suspended");
  assertStringIncludes(html, "tone-waiting");
  // Dependencies are spelled out for screen readers.
  assertStringIncludes(html, ", after approve");
});

Deno.test("MiniDag: highlight emphasises nodes and the edges between them", () => {
  const html = renderToStaticMarkup(
    <MiniDag
      nodes={nodes}
      edges={edges}
      highlight={["approve", "deploy"]}
      label="Jobs"
    />,
  );
  assertEquals(html.match(/mini-dag-node[^"]* hl"/g)?.length, 2);
  assertEquals(html.match(/mini-dag-node[^"]* muted"/g)?.length, 2);
  assertEquals(html.match(/class="mini-dag-edge hl"/g)?.length, 1);
});

Deno.test("MiniDag: renders nothing without nodes", () => {
  assertEquals(
    renderToStaticMarkup(<MiniDag nodes={[]} edges={[]} label="Jobs" />),
    "",
  );
});
