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

/**
 * The static half of the container rule (design/enablers/typed-secrets.md
 * Section 4.3 item 5). cel-js answers `in` and list or map equality without
 * calling any handler (fact 2), so no refusing overload sees a secret there.
 * An expression that has a container comparison and reads a secret is
 * refused as a whole.
 */

import type { ASTNode } from "cel-js";

/** A node of a parsed expression: an operator and its arguments. */
interface Node {
  readonly op: string;
  readonly args: unknown;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null &&
    typeof (value as { op?: unknown }).op === "string";
}

/**
 * A scalar literal: a `value` node (string, int, uint, double, bytes, bool
 * or `null`), or unary minus over one, since `-1` parses as minus over `1`.
 * A call such as `uint(1)` is not a literal.
 */
function isScalarLiteral(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.op === "value") return true;
  return node.op === "-_" && isScalarLiteral(node.args);
}

/**
 * Whether the expression holds a container comparison: an `in`, or an `==`
 * or `!=` with no operand that is a scalar literal or `null`. A scalar
 * compared with a container is `false` today and after, so it needs no
 * rule. Every node is visited, whatever shape its arguments take: a unary
 * operator holds one node, a map literal holds key and value pairs, and a
 * call nests its argument list.
 */
export function hasContainerComparison(ast: ASTNode): boolean {
  return visit(ast);
}

function visit(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(visit);
  if (!isNode(value)) return false;
  // A literal's arguments are its value, never a node.
  if (value.op === "value") return false;
  if (value.op === "in") return true;
  if (
    (value.op === "==" || value.op === "!=") && Array.isArray(value.args) &&
    !value.args.some(isScalarLiteral)
  ) {
    return true;
  }
  return visit(value.args);
}
