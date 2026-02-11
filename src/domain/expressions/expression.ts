// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Represents a location within a YAML document where an expression was found.
 */
export interface ExpressionLocation {
  /** The path to the value in the YAML structure (e.g., "attributes.message") */
  path: string;
  /** The raw string containing the expression (e.g., "${{ model.foo.input.attributes.x }}") */
  raw: string;
  /** The CEL expression extracted from the raw string (e.g., "model.foo.input.attributes.x") */
  celExpression: string;
}

/**
 * Expression is a value object representing a CEL expression found in input/workflow data.
 *
 * Expressions use the syntax ${{ <cel-expression> }} and can reference:
 * - Other model inputs: model.<name-or-id>.input.attributes.<attr>
 * - Model resources: model.<name-or-id>.resource.attributes.<attr>
 * - Self-references: self.name, self.version, self.attributes.<attr>
 * - Workflow context: workflow.<property>
 */
export class Expression {
  private constructor(
    /** The raw string containing the expression wrapper */
    readonly raw: string,
    /** The CEL expression without the ${{ }} wrapper */
    readonly celExpression: string,
    /** The path in the YAML where this expression was found */
    readonly path: string,
  ) {}

  /**
   * Creates an Expression from a raw string and path.
   *
   * @param raw - The raw string containing ${{ ... }}
   * @param celExpression - The extracted CEL expression
   * @param path - The path in the YAML document
   */
  static create(raw: string, celExpression: string, path: string): Expression {
    return new Expression(raw, celExpression, path);
  }

  /**
   * Creates an Expression from an ExpressionLocation.
   */
  static fromLocation(location: ExpressionLocation): Expression {
    return new Expression(location.raw, location.celExpression, location.path);
  }

  /**
   * Converts to an ExpressionLocation for compatibility.
   */
  toLocation(): ExpressionLocation {
    return {
      path: this.path,
      raw: this.raw,
      celExpression: this.celExpression,
    };
  }
}
