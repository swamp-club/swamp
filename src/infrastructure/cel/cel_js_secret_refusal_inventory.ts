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
 * each secret-capable position has exactly one disposition; built-ins come from
 * env.getDefinitions(), so a dependency bump that adds one fails until it is
 * classified
 */

import type { DefinitionFunction, Environment } from "cel-js";

export const SECRET_TYPE_NAME = "Secret";

/**
 * a Secret is a dyn value at run time, so cel-js dispatches it to any of these;
 * a scalar type such as int or bytes never matches it
 */
export function isSecretCapableType(type: string): boolean {
  return type === "string" || type === "dyn" || /^[A-Z]$/.test(type) ||
    /^(list|map|optional|dyn)<.*>$/.test(type);
}

/** null is not here: Secret == null is in the allowed set and answers false */
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
 * includes null so any binary operator with a Secret on one side records a
 * fault: Secret == null is allowed, Secret < null is a refusal
 */
export function operandTypes(customTypes: readonly string[]): string[] {
  return [...equalityTypes(customTypes), "null"];
}

export function isTypeWithoutEquality(name: string): boolean {
  return name === "ast" || name === "dyn" || name === "null" ||
    /^[A-Z]$/.test(name);
}

/**
 * a test keeps this equal to EQUALITY_TYPES plus custom types, so a type a
 * dependency bump adds fails a test instead of slipping past the refusals
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
 * excluded from the generated refusals so the two sets never collide at
 * registration
 */
export const ALLOWED_OPERATOR_SIGNATURES: readonly string[] = [
  "Secret + string",
  "string + Secret",
  "Secret + Secret",
  "Secret == null",
];

export const INTERNAL_FUNCTION_SIGNATURES: readonly string[] = [
  "literal(string): string",
  "CelFileNamespace.contents(string, string): dyn",
  "CelDataNamespace.latest(string, string): dyn",
  "CelDataNamespace.version(string, string, int): dyn",
  "CelDataNamespace.version(string, string, double): dyn",
  "CelDataNamespace.listVersions(string, string): dyn",
  "CelDataNamespace.latest(string, string, list<dyn>): dyn",
  "CelDataNamespace.version(string, string, list<dyn>, int): dyn",
  "CelDataNamespace.version(string, string, list<dyn>, double): dyn",
  "CelDataNamespace.listVersions(string, string, list<dyn>): dyn",
  "CelDataNamespace.findByTag(string, string): dyn",
  "CelDataNamespace.findBySpec(string, string): dyn",
  "CelDataNamespace.query(string): dyn",
  "CelDataNamespace.query(string, string): dyn",
  "CelWorkersNamespace.connected(): dyn",
  "CelModelNamespace.method(string, string): dyn",
  "CelModelNamespace.method(string, string, dyn): dyn",
];

export const TYPED_VAULT_FUNCTION_SIGNATURES: readonly string[] = [
  "CelVaultNamespace.get(string, string): Secret",
];
export const TYPED_VAULT_NAMESPACE_TYPES: readonly string[] = [
  "CelVaultNamespace",
];

export const QUERY_VIEW_FUNCTION_SIGNATURES: readonly string[] = [
  "latestRun(string): dyn",
  "model(string): bool",
  "behavior(string): bool",
];

export const SWAMP_FUNCTION_SIGNATURES: readonly string[] = [
  ...INTERNAL_FUNCTION_SIGNATURES,
  ...QUERY_VIEW_FUNCTION_SIGNATURES,
  ...TYPED_VAULT_FUNCTION_SIGNATURES,
];

/**
 * none has a secret-capable operand; listed so the fitness test proves its scan
 * of registerOperator finds something
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

export interface ParsedSignature {
  readonly signature: string;
  readonly receiverType: string | null;
  readonly name: string;
  readonly params: readonly string[];
  readonly returnType: string;
}

export interface PositionDisposition {
  readonly signature: string;
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

export function qualifiedName(parsed: ParsedSignature): string {
  return parsed.receiverType === null
    ? parsed.name
    : `${parsed.receiverType}.${parsed.name}`;
}

/**
 * a secret-capable position not named here other than a string is unclassified
 * and classifyPositions throws, so a dependency bump never classifies a new
 * built-in silently
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

export function specialDispositionNames(): string[] {
  return [...SPECIAL_DISPOSITIONS.keys()].sort();
}

const TYPE_NAME_FUNCTIONS: ReadonlySet<string> = new Set(["type"]);

const AST_PARAMETER = "ast";

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

export function secretCapableBuiltins(env: Environment): DefinitionFunction[] {
  return env.getDefinitions().functions.filter((fn) =>
    (fn.receiverType !== null && isSecretCapableType(fn.receiverType)) ||
    fn.params.some((p) => isSecretCapableType(p.type))
  );
}

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

export function equalityTypes(customTypes: readonly string[]): string[] {
  return [
    ...EQUALITY_TYPES,
    ...customTypes.filter((t) => !EQUALITY_TYPES.includes(t)),
  ];
}

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
