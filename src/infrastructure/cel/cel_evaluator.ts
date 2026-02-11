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

import { Environment } from "cel-js";
import { InvalidExpressionError } from "../../domain/expressions/errors.ts";
import { transformHyphenatedModelRefs } from "../../domain/expressions/expression_parser.ts";

/**
 * Result of expression validation.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Recursively converts bigint values to numbers.
 * cel-js v7+ uses bigint for CEL int type, but the rest of the codebase
 * expects regular JS numbers. Values outside Number.MAX_SAFE_INTEGER are
 * left as bigint to avoid silent precision loss.
 */
function coerceBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
      return Number(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(coerceBigInts);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = coerceBigInts(v);
    }
    return result;
  }
  return value;
}

/**
 * Wrapper class for file namespace context objects.
 * cel-js requires a registered type (via constructor matching) so it doesn't
 * try to infer the type as a map and choke on function-valued properties.
 */
export class CelFileNamespace {
  private readonly delegate: Record<string, unknown>;

  constructor(delegate: Record<string, unknown>) {
    this.delegate = delegate;
  }

  contents(modelName: string, specName: string): unknown {
    const fn = this.delegate["contents"];
    if (typeof fn === "function") {
      return (fn as (m: string, s: string) => unknown)(modelName, specName);
    }
    return null;
  }
}

/**
 * Wrapper class for data namespace context objects.
 */
export class CelDataNamespace {
  private readonly delegate: Record<string, unknown>;

  constructor(delegate: Record<string, unknown>) {
    this.delegate = delegate;
  }

  latest(modelName: string, dataName: string): unknown {
    const fn = this.delegate["latest"];
    if (typeof fn === "function") {
      return (fn as (m: string, d: string) => unknown)(modelName, dataName);
    }
    return null;
  }

  version(modelName: string, dataName: string, version: unknown): unknown {
    const fn = this.delegate["version"];
    if (typeof fn === "function") {
      return (fn as (m: string, d: string, v: unknown) => unknown)(
        modelName,
        dataName,
        version,
      );
    }
    return null;
  }

  listVersions(modelName: string, dataName: string): unknown {
    const fn = this.delegate["listVersions"];
    if (typeof fn === "function") {
      return (fn as (m: string, d: string) => unknown)(modelName, dataName);
    }
    return [];
  }

  findByTag(tagKey: string, tagValue: string): unknown {
    const fn = this.delegate["findByTag"];
    if (typeof fn === "function") {
      return (fn as (k: string, v: string) => unknown)(tagKey, tagValue);
    }
    return [];
  }

  findBySpec(modelName: string, specName: string): unknown {
    const fn = this.delegate["findBySpec"];
    if (typeof fn === "function") {
      return (fn as (m: string, s: string) => unknown)(modelName, specName);
    }
    return [];
  }
}

/**
 * CEL evaluator that wraps the cel-js library.
 *
 * Uses the cel-js Environment class with registered types and receiver methods
 * to support function call syntax (e.g., file.contents(), data.latest()) in
 * CEL expressions.
 */
export class CelEvaluator {
  private readonly env: Environment;

  constructor() {
    this.env = new Environment({ unlistedVariablesAreDyn: true });

    // Register mixed-type arithmetic overloads. Context values from model
    // attributes are JS numbers (double), but CEL integer literals are bigint
    // (int). Without these, expressions like `count * 2` fail.
    this.env.registerOperator(
      "double + int",
      (a: number, b: bigint) => a + Number(b),
    );
    this.env.registerOperator(
      "int + double",
      (a: bigint, b: number) => Number(a) + b,
    );
    this.env.registerOperator(
      "double - int",
      (a: number, b: bigint) => a - Number(b),
    );
    this.env.registerOperator(
      "int - double",
      (a: bigint, b: number) => Number(a) - b,
    );
    this.env.registerOperator(
      "double * int",
      (a: number, b: bigint) => a * Number(b),
    );
    this.env.registerOperator(
      "int * double",
      (a: bigint, b: number) => Number(a) * b,
    );
    this.env.registerOperator(
      "double / int",
      (a: number, b: bigint) => a / Number(b),
    );
    this.env.registerOperator(
      "int / double",
      (a: bigint, b: number) => Number(a) / b,
    );
    this.env.registerOperator(
      "double % int",
      (a: number, b: bigint) => a % Number(b),
    );
    this.env.registerOperator(
      "int % double",
      (a: bigint, b: number) => Number(a) % b,
    );

    // Register namespace types so cel-js recognizes them via constructor
    // matching instead of trying to infer them as maps.
    this.env.registerType("CelFileNamespace", CelFileNamespace);
    this.env.registerType("CelDataNamespace", CelDataNamespace);

    // Register receiver methods for file namespace
    this.env.registerFunction(
      "CelFileNamespace.contents(string, string): dyn",
      (receiver: CelFileNamespace, modelName: string, specName: string) =>
        receiver.contents(modelName, specName),
    );

    // Register receiver methods for data namespace
    this.env.registerFunction(
      "CelDataNamespace.latest(string, string): dyn",
      (receiver: CelDataNamespace, modelName: string, dataName: string) =>
        receiver.latest(modelName, dataName),
    );

    this.env.registerFunction(
      "CelDataNamespace.version(string, string, int): dyn",
      (
        receiver: CelDataNamespace,
        modelName: string,
        dataName: string,
        version: unknown,
      ) => receiver.version(modelName, dataName, version),
    );

    this.env.registerFunction(
      "CelDataNamespace.listVersions(string, string): dyn",
      (receiver: CelDataNamespace, modelName: string, dataName: string) =>
        receiver.listVersions(modelName, dataName),
    );

    this.env.registerFunction(
      "CelDataNamespace.findByTag(string, string): dyn",
      (receiver: CelDataNamespace, tagKey: string, tagValue: string) =>
        receiver.findByTag(tagKey, tagValue),
    );

    this.env.registerFunction(
      "CelDataNamespace.findBySpec(string, string): dyn",
      (receiver: CelDataNamespace, modelName: string, specName: string) =>
        receiver.findBySpec(modelName, specName),
    );
  }

  /**
   * Evaluates a CEL expression with the given context.
   *
   * @param expression - The CEL expression to evaluate
   * @param context - The context object containing model, self, workflow data
   * @returns The evaluated result
   * @throws InvalidExpressionError if evaluation fails
   */
  evaluate(expression: string, context: Record<string, unknown>): unknown {
    try {
      // Transform hyphenated model names to bracket notation before evaluation
      const transformedExpr = transformHyphenatedModelRefs(expression);

      // Wrap file/data namespace objects in registered types so cel-js can
      // resolve receiver methods instead of treating them as maps.
      const wrappedContext = this.wrapNamespaces(context);

      const result = this.env.evaluate(transformedExpr, wrappedContext);
      return coerceBigInts(result);
    } catch (error) {
      throw new InvalidExpressionError(
        error instanceof Error ? error.message : String(error),
        expression,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Validates a CEL expression without evaluating it.
   *
   * @param expression - The CEL expression to validate
   * @returns Validation result with error message if invalid
   */
  validate(expression: string): ValidationResult {
    try {
      // Attempt to parse the expression — ParseResult is callable, not a
      // success/error union.  If parse() doesn't throw, the syntax is valid.
      this.env.parse(expression);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Wraps file and data namespace context objects in their registered CEL types.
   */
  private wrapNamespaces(
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    const file = context["file"];
    const data = context["data"];
    if (!file && !data) return context;

    const wrapped = { ...context };
    if (
      file && typeof file === "object" && !(file instanceof CelFileNamespace)
    ) {
      wrapped["file"] = new CelFileNamespace(file as Record<string, unknown>);
    }
    if (
      data && typeof data === "object" && !(data instanceof CelDataNamespace)
    ) {
      wrapped["data"] = new CelDataNamespace(data as Record<string, unknown>);
    }
    return wrapped;
  }
}
