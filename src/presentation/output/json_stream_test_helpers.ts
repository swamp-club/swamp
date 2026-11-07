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

/** past the depth native JSON.stringify survives; built without recursion */
export function deeplyNestedAttributes(
  depth = 6_000,
): { i: number; tree: unknown } {
  let tree: unknown = [0, 1, 2];
  for (let n = 0; n < depth; n++) tree = [tree];
  return { i: 0, tree };
}

/** the nesting depth of deeplyNestedAttributes' tree, and its innermost array */
export function nestedTreeDepth(
  attributes: { tree: unknown },
): { depth: number; leaf: unknown } {
  let node = attributes.tree;
  let depth = 0;
  while (Array.isArray(node) && node.length === 1 && Array.isArray(node[0])) {
    node = node[0];
    depth++;
  }
  return { depth, leaf: node };
}

/** JSON.stringify(deeplyNestedAttributes(depth), null, 2), built without recursion */
export function prettyNestedText(depth: number): string {
  const indent = (level: number) => "  ".repeat(level);
  const parts = ['{\n  "i": 0,\n  "tree": '];
  for (let level = 1; level <= depth; level++) {
    parts.push(`[\n${indent(level + 1)}`);
  }
  const leaf = indent(depth + 2);
  parts.push(`[\n${leaf}0,\n${leaf}1,\n${leaf}2\n${indent(depth + 1)}]`);
  for (let level = depth; level >= 1; level--) {
    parts.push(`\n${indent(level)}]`);
  }
  parts.push("\n}");
  return parts.join("");
}
