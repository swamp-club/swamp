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
 * The refusal inventory for the typed-secrets `Secret` value, pinned against
 * cel-js 7.6.1 (design/enablers/typed-secrets.md Section 4.3).
 *
 * It answers one question for every place a `Secret` can meet a cel-js
 * built-in or one of swamp's own registrations: what happens to it there. Each
 * secret-capable position (a receiver or a parameter typed `string`, `dyn`, a
 * type variable, or a list, map or optional of anything, see
 * {@link isSecretCapableType}) has exactly one disposition:
 *
 * - `refusal`: a refusing overload with `Secret` in that position is
 *   registered. The refusal signatures are the full cross product over a
 *   signature's refusal positions, all-`Secret` combinations included, because
 *   one overload per position leaves a call with two secrets to a
 *   missing-overload error that records no fault and is absorbed.
 * - `named-delivery`: the value is passed along by design and the callee owns
 *   it (`dyn(dyn)`, `cel.bind`, `optional.of`, `optional.value`,
 *   `optional.orValue`, and the `inputs` of `CelModelNamespace.method`).
 *   `model.method` converts its inputs at the boundary (Section 4.5,
 *   typed-secrets 3.5): each `Secret` becomes a sentinel of the run's bag
 *   and the delegate receives a plain copy; with no bag a `Secret` there is
 *   refused with `secret_destination_refused`. Its string positions, the
 *   model and method names, are routing arguments whose refusal records
 *   `secret_destination_refused` rather than `secret_operation_unsupported`.
 * - `argument-walk`: the position takes a list a `Secret` may sit in, and the
 *   handler walks it at run time (`secret_destination_refused` for the vary
 *   list of the data accessors). No signature can refuse an element.
 * - `container`: a built-in that takes a container a `Secret` may sit in and
 *   reveals nothing: `size` and `type` of a list or map, the `join` receiver,
 *   the comprehension macros over a list, and `hasValue` and `or` on an
 *   optional. A getter records the element when the built-in reads it. `join`
 *   is the one that records nothing on its own: cel-js checks the element
 *   types itself and throws `invalid_list_element_type` before any handler,
 *   and a `list<dyn>.join` overload never intercepts it (pinned). It reveals
 *   nothing, and it is documented beside `in` as an unrecorded failure.
 * - `type-name`: `type(x)`. cel-js registers `type(Secret): type` itself when
 *   the type is registered and a second registration is an overlap error, so
 *   `type(S)` answers the type name and reveals nothing.
 *
 * Where the lists come from, and why:
 *
 * - Built-in functions come from cel-js itself, through
 *   `Environment.getDefinitions()`, which lists every global function. A
 *   dependency bump that adds one therefore reaches the classifier and fails
 *   until it has a disposition.
 * - Built-in operators and the equality type list are maintained here. The
 *   registry keeps its operator list private, and the package export map does
 *   not expose `lib/registry.js`, where the type table lives.
 * - swamp's own registrations are maintained here too, and
 *   `integration/cel_secret_refusal_coverage_rules_test.ts` fails when they
 *   drift from the source.
 *
 * It is the source of the production registrations
 * (`secret_registrations.ts`), and the Phase 1.2 pins in `cel_js_pins/`
 * observe cel-js against it.
 */

import type { DefinitionFunction, Environment } from "cel-js";

/** The registered type name of the secret value. */
export const SECRET_TYPE_NAME = "Secret";

/**
 * Whether a `Secret` can reach a position declared with `type`: `string`,
 * `dyn`, a type variable such as `A`, or a list, map or optional of anything.
 * A `Secret` is a dyn value at run time, so cel-js dispatches it to any of
 * these; a scalar type such as `int` or `bytes` never matches it.
 */
export function isSecretCapableType(type: string): boolean {
  return type === "string" || type === "dyn" || /^[A-Z]$/.test(type) ||
    /^(list|map|optional|dyn)<.*>$/.test(type);
}

/**
 * Every type name cel-js 7.6.1 can name in an operator signature, `Secret`
 * among them: the scalar and aggregate types, the optional, the two protobuf
 * well-known types it registers with their own `==`, `+`, `-` and comparison
 * overloads, and the two namespace singletons bound as `cel` and `optional`.
 * `null` is not here: `Secret == null` is in the allowed set and answers
 * `false`. Custom types an environment registers are appended by
 * {@link equalityTypes}. {@link typeNamesInDefinitions} pins this list
 * against the names cel-js uses in its own definitions.
 */
export const EQUALITY_TYPES: readonly string[] = [
  "string",
  "bool",
  "int",
  "uint",
  "double",
  "bytes",
  "type",
  "list",
  "map",
  "optional",
  "google.protobuf.Timestamp",
  "google.protobuf.Duration",
  "CelNamespace",
  "OptionalNamespace",
  SECRET_TYPE_NAME,
];

/**
 * The operand types the arithmetic and comparison refusals pair with: every
 * equality type, the environment's custom types, and `null`, so any binary
 * operator with a `Secret` on one side records a fault whatever is on the
 * other. `null` is here although it is not an equality type: `Secret == null`
 * is the allowed set's answer, `Secret < null` is a refusal.
 */
export function operandTypes(customTypes: readonly string[]): string[] {
  return [...equalityTypes(customTypes), "null"];
}

/**
 * Names that appear in cel-js's definitions without being types a `Secret`
 * can be compared with: macro syntax, the dyn pseudo-type, `null` (the
 * allowed set answers it) and type variables.
 */
export function isTypeWithoutEquality(name: string): boolean {
  return name === "ast" || name === "dyn" || name === "null" ||
    /^[A-Z]$/.test(name);
}

/**
 * Every base type name cel-js uses in its function definitions on `env`
 * (receivers, parameters and return types, with type arguments stripped),
 * minus {@link isTypeWithoutEquality}. A test keeps this equal to
 * {@link EQUALITY_TYPES} plus the environment's custom types, so a type a
 * dependency bump adds fails a test instead of slipping past the refusals.
 */
export function typeNamesInDefinitions(env: Environment): string[] {
  const names = new Set<string>();
  for (const fn of env.getDefinitions().functions) {
    const types = [
      fn.receiverType,
      fn.returnType,
      ...fn.params.map((p) => p.type),
    ];
    for (const type of types) {
      if (type === null) continue;
      const base = type.replace(/<.*$/, "");
      if (!isTypeWithoutEquality(base)) names.add(base);
    }
  }
  return [...names].sort();
}

export const ARITHMETIC_OPERATORS: readonly string[] = [
  "+",
  "-",
  "*",
  "/",
  "%",
];
export const COMPARISON_OPERATORS: readonly string[] = ["<", "<=", ">", ">="];
export const UNARY_OPERATORS: readonly string[] = ["!", "-"];

/**
 * The allowed set (Section 4.1): the only operator signatures with a `Secret`
 * operand that answer instead of refusing. They are excluded from the
 * generated refusals so the two sets never collide at registration.
 */
export const ALLOWED_OPERATOR_SIGNATURES: readonly string[] = [
  "Secret + string",
  "string + Secret",
  "Secret + Secret",
  "Secret == null",
];

/**
 * swamp's own registrations in the internal environment (cel_evaluator.ts and
 * cel_grammar.ts), as cel-js signatures. The internal environment registers
 * the refusals these yield.
 */
export const INTERNAL_FUNCTION_SIGNATURES: readonly string[] = [
  "literal(string): string",
  "CelFileNamespace.contents(string, string): dyn",
  "CelDataNamespace.latest(string, string): dyn",
  "CelDataNamespace.version(string, string, int): dyn",
  "CelDataNamespace.listVersions(string, string): dyn",
  "CelDataNamespace.latest(string, string, list<dyn>): dyn",
  "CelDataNamespace.version(string, string, list<dyn>, int): dyn",
  "CelDataNamespace.listVersions(string, string, list<dyn>): dyn",
  "CelDataNamespace.findByTag(string, string): dyn",
  "CelDataNamespace.findBySpec(string, string): dyn",
  "CelDataNamespace.query(string): dyn",
  "CelDataNamespace.query(string, string): dyn",
  "CelWorkersNamespace.connected(): dyn",
  "CelModelNamespace.method(string, string): dyn",
  "CelModelNamespace.method(string, string, dyn): dyn",
];

/** Registrations added only when typed secrets are enabled. */
export const TYPED_VAULT_FUNCTION_SIGNATURES: readonly string[] = [
  "CelVaultNamespace.get(string, string): Secret",
];
export const TYPED_VAULT_NAMESPACE_TYPES: readonly string[] = [
  "CelVaultNamespace",
];

/**
 * swamp's own registrations in the query view (data_query_service.ts). Its
 * refusals arrive with the query view (design Section 6.2, Phase 4).
 */
export const QUERY_VIEW_FUNCTION_SIGNATURES: readonly string[] = [
  "latestRun(string): dyn",
  "model(string): bool",
  "behavior(string): bool",
];

/**
 * Every function swamp registers, in the internal environment and the query
 * view. The fitness test keeps this list equal to the source.
 */
export const SWAMP_FUNCTION_SIGNATURES: readonly string[] = [
  ...INTERNAL_FUNCTION_SIGNATURES,
  ...QUERY_VIEW_FUNCTION_SIGNATURES,
  ...TYPED_VAULT_FUNCTION_SIGNATURES,
];

/**
 * swamp's own operator registrations (the mixed int/double arithmetic in
 * cel_evaluator.ts). None has a secret-capable operand; they are listed so
 * the fitness test proves its scan of `registerOperator` finds something.
 */
export const SWAMP_OPERATOR_SIGNATURES: readonly string[] = [
  "double + int",
  "int + double",
  "double - int",
  "int - double",
  "double * int",
  "int * double",
  "double / int",
  "int / double",
  "double % int",
  "int % double",
];

/** The custom receiver types swamp registers in the internal environment. */
export const SWAMP_NAMESPACE_TYPES: readonly string[] = [
  "CelFileNamespace",
  "CelDataNamespace",
  "CelWorkersNamespace",
  "CelModelNamespace",
];

export type Disposition =
  | "refusal"
  | "named-delivery"
  | "argument-walk"
  | "container"
  | "type-name";

/** A parsed signature: `receiver.name(params): returnType`. */
export interface ParsedSignature {
  readonly signature: string;
  readonly receiverType: string | null;
  readonly name: string;
  readonly params: readonly string[];
  readonly returnType: string;
}

/** One secret-capable position of a signature and what happens to it. */
export interface PositionDisposition {
  readonly signature: string;
  /** `receiver`, or the zero-based parameter index. */
  readonly position: "receiver" | number;
  readonly type: string;
  readonly disposition: Disposition;
}

/**
 * `receiver.name(params): returnType`. The receiver is greedy up to the last
 * dot before the name, so `google.protobuf.Timestamp.getDate` and a
 * definition's `map<dyn, dyn>.size` both parse.
 */
const SIGNATURE = /^(?:(.+)\.)?(\w+)\(([^)]*)\):(.*)$/;

/** Parse a cel-js function signature. Throws on a malformed one. */
export function parseSignature(signature: string): ParsedSignature {
  const match = SIGNATURE.exec(signature);
  if (match === null) throw new Error(`Invalid signature: ${signature}`);
  const [, receiverType, name, params, returnType] = match;
  return {
    signature,
    receiverType: receiverType ?? null,
    name,
    params: splitParams(params),
    returnType: returnType.trim(),
  };
}

/** Split a parameter list on top-level commas (`map<dyn, dyn>` stays one). */
function splitParams(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of params) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** The qualified name of a signature: `receiver.name` or `name`. */
export function qualifiedName(parsed: ParsedSignature): string {
  return parsed.receiverType === null
    ? parsed.name
    : `${parsed.receiverType}.${parsed.name}`;
}

/**
 * Dispositions other than `refusal`, by qualified name. A position of a
 * function named here that carries the listed type takes that disposition;
 * every other secret-capable `string` position is a refusal. Any other
 * secret-capable position not named here (a `dyn`, a type variable, a list,
 * map or optional) is unclassified and {@link classifyPositions} throws,
 * because a secret there cannot be refused by a signature and needs a
 * decision. That is the alarm a dependency bump trips: a new generic or
 * container-taking built-in is never classified silently.
 */
const SPECIAL_DISPOSITIONS: ReadonlyMap<
  string,
  { readonly types: readonly string[]; readonly disposition: Disposition }
> = new Map([
  ["dyn", { types: ["dyn"], disposition: "named-delivery" }],
  ["CelNamespace.bind", { types: ["dyn"], disposition: "named-delivery" }],
  ["OptionalNamespace.of", { types: ["A"], disposition: "named-delivery" }],
  ["optional<A>.value", {
    types: ["optional<A>"],
    disposition: "named-delivery",
  }],
  [
    "optional<dyn>.orValue",
    { types: ["optional<dyn>"], disposition: "named-delivery" },
  ],
  ["optional<dyn>.hasValue", {
    types: ["optional<dyn>"],
    disposition: "container",
  }],
  ["optional<dyn>.or", { types: ["optional<dyn>"], disposition: "container" }],
  [
    "CelModelNamespace.method",
    { types: ["dyn"], disposition: "named-delivery" },
  ],
  [
    "CelDataNamespace.latest",
    { types: ["list<dyn>"], disposition: "argument-walk" },
  ],
  [
    "CelDataNamespace.version",
    { types: ["list<dyn>"], disposition: "argument-walk" },
  ],
  [
    "CelDataNamespace.listVersions",
    { types: ["list<dyn>"], disposition: "argument-walk" },
  ],
  ["size", { types: ["list<dyn>", "map<dyn, dyn>"], disposition: "container" }],
  ["type", { types: ["list<dyn>", "map<dyn, dyn>"], disposition: "container" }],
  ["list<dyn>.size", { types: ["list<dyn>"], disposition: "container" }],
  ["map<dyn, dyn>.size", {
    types: ["map<dyn, dyn>"],
    disposition: "container",
  }],
  ["list<string>.join", { types: ["list<string>"], disposition: "container" }],
  ["list<dyn>.all", { types: ["list<dyn>"], disposition: "container" }],
  ["list<dyn>.exists", { types: ["list<dyn>"], disposition: "container" }],
  ["list<dyn>.exists_one", { types: ["list<dyn>"], disposition: "container" }],
  ["list<dyn>.map", { types: ["list<dyn>"], disposition: "container" }],
  ["list<dyn>.filter", { types: ["list<dyn>"], disposition: "container" }],
]);

/** The qualified names the special dispositions refer to. */
export function specialDispositionNames(): string[] {
  return [...SPECIAL_DISPOSITIONS.keys()].sort();
}

/** Functions whose `string` position is answered by `type(Secret)` itself. */
const TYPE_NAME_FUNCTIONS: ReadonlySet<string> = new Set(["type"]);

/** Parameters that are macro syntax, never a value. */
const AST_PARAMETER = "ast";

/**
 * Classify every secret-capable position of a signature. Throws when a
 * position has no disposition, which is the alarm a dependency bump trips.
 */
export function classifyPositions(signature: string): PositionDisposition[] {
  const parsed = parseSignature(signature);
  const name = qualifiedName(parsed);
  const special = SPECIAL_DISPOSITIONS.get(name);
  const positions: Array<["receiver" | number, string]> = [];
  if (parsed.receiverType !== null) {
    positions.push(["receiver", parsed.receiverType]);
  }
  parsed.params.forEach((type, index) => positions.push([index, type]));

  const out: PositionDisposition[] = [];
  for (const [position, type] of positions) {
    if (type === AST_PARAMETER) continue;
    if (!isSecretCapableType(type)) continue;
    const disposition = dispositionFor(name, position, type, special);
    if (disposition === undefined) {
      throw new Error(
        `Unclassified secret-capable position in ${signature}: ` +
          `${String(position)} is ${type}. Decide its disposition in ` +
          "cel_js_secret_refusal_inventory.ts.",
      );
    }
    out.push({ signature, position, type, disposition });
  }
  return out;
}

function dispositionFor(
  name: string,
  position: "receiver" | number,
  type: string,
  special:
    | { readonly types: readonly string[]; readonly disposition: Disposition }
    | undefined,
): Disposition | undefined {
  if (special !== undefined && special.types.includes(type)) {
    return special.disposition;
  }
  if (type === "string") {
    if (TYPE_NAME_FUNCTIONS.has(name) && position !== "receiver") {
      return "type-name";
    }
    return "refusal";
  }
  return undefined;
}

/**
 * The cel-js functions a `Secret` can reach: every global function whose
 * receiver or a parameter is secret-capable, read from the environment.
 */
export function secretCapableBuiltins(env: Environment): DefinitionFunction[] {
  return env.getDefinitions().functions.filter((fn) =>
    (fn.receiverType !== null && isSecretCapableType(fn.receiverType)) ||
    fn.params.some((p) => isSecretCapableType(p.type))
  );
}

/**
 * The refusal signatures for a list of function signatures: for each one,
 * every non-empty subset of its refusal positions with `Secret` substituted,
 * other positions as declared. Sorted and unique.
 */
export function functionRefusalSignatures(
  signatures: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const signature of signatures) {
    const parsed = parseSignature(signature);
    const refusals = classifyPositions(signature).filter((p) =>
      p.disposition === "refusal"
    );
    const count = refusals.length;
    for (let mask = 1; mask < 1 << count; mask++) {
      let receiver = parsed.receiverType;
      const params = [...parsed.params];
      refusals.forEach((p, i) => {
        if ((mask & (1 << i)) === 0) return;
        if (p.position === "receiver") receiver = SECRET_TYPE_NAME;
        else params[p.position] = SECRET_TYPE_NAME;
      });
      const head = receiver === null
        ? parsed.name
        : `${receiver}.${parsed.name}`;
      out.add(`${head}(${params.join(", ")}): ${parsed.returnType}`);
    }
  }
  return [...out].sort();
}

/** The equality types with an environment's custom type names appended. */
export function equalityTypes(customTypes: readonly string[]): string[] {
  return [
    ...EQUALITY_TYPES,
    ...customTypes.filter((t) => !EQUALITY_TYPES.includes(t)),
  ];
}

/**
 * The refusing operator signatures: `Secret == T` for every equality type
 * (`!=` and the mirrored order are derived by cel-js), both operand orders of
 * every arithmetic and comparison operator against every operand type, `null`
 * and the custom types included, and the unary operators. The allowed set is
 * excluded.
 */
export function operatorRefusalSignatures(
  customTypes: readonly string[] = [],
): string[] {
  const out = new Set<string>();
  for (const type of equalityTypes(customTypes)) {
    out.add(`${SECRET_TYPE_NAME} == ${type}`);
  }
  for (const op of [...ARITHMETIC_OPERATORS, ...COMPARISON_OPERATORS]) {
    for (const type of operandTypes(customTypes)) {
      out.add(`${SECRET_TYPE_NAME} ${op} ${type}`);
      out.add(`${type} ${op} ${SECRET_TYPE_NAME}`);
    }
  }
  for (const op of UNARY_OPERATORS) out.add(`${op}${SECRET_TYPE_NAME}`);
  for (const allowed of ALLOWED_OPERATOR_SIGNATURES) out.delete(allowed);
  return [...out].sort();
}
