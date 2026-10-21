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

/** Reference-only CEL vault receiver and the pre-execution reference checks. */
import type { Environment } from "cel-js";
import { InvalidExpressionError } from "../../domain/expressions/errors.ts";
import {
  editCelSource,
  type SourceEdit,
  type VaultCallAnalysis,
  type VaultGetCall,
} from "../../domain/expressions/vault_call_syntax.ts";
import {
  checkSecretReference,
  type ProbeRedactor,
} from "../../domain/vaults/secret_reference_check.ts";
import type { SecretReference } from "../../domain/vaults/secret_bag_registry.ts";
import type { VaultService } from "../../domain/vaults/vault_service.ts";
import type { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { recordSecretRead, refuse } from "./secret_fault_context.ts";
import { isSecret, type Secret, vaultReferenceSecret } from "./secret_value.ts";

/** The same domain services the legacy resolver and delivery use. */
export interface VaultEvaluationScope {
  readonly service: VaultService;
  readonly redactor: ProbeRedactor;
  /** The authored field path; call line/column is appended to it. */
  readonly location: string;
}

/**
 * One checked call site. No provider or value lives on the receiver. A call
 * creates a production Secret and records the read even without a binding getter.
 */
export class CelVaultNamespace {
  constructor(
    private readonly reference: SecretReference,
    private readonly location: string,
  ) {}

  get(vaultName: string, key: string): Secret {
    if (vaultName !== this.reference.vaultName || key !== this.reference.key) {
      return refuse("an unchecked vault.get reference");
    }
    recordSecretRead();
    return vaultReferenceSecret(this.reference, this.location);
  }
}

/** Checks namespace use before any argument is evaluated or provider is asked. */
export function assertDirectVaultCalls(
  analysis: VaultCallAnalysis,
  expression: string,
): void {
  if (analysis.invalidUses.length > 0) {
    throw new InvalidExpressionError(
      "Call vault.get(vaultName, secretKey) directly; other uses of vault are unsupported",
      expression,
    );
  }
  if (analysis.calls.some((call) => call.args.length !== 2)) {
    throw new InvalidExpressionError(
      "vault.get requires exactly two string arguments",
      expression,
    );
  }
  if (analysis.calls.some((call) => call.usesLocalBinding)) {
    throw new InvalidExpressionError(
      "vault.get arguments cannot depend on surrounding CEL local bindings",
      expression,
    );
  }
  if (
    analysis.calls.some((call) =>
      call.args.some((arg) => containsMethodCall(arg.node))
    )
  ) {
    throw new InvalidExpressionError(
      "vault.get arguments cannot invoke model.method during up-front checking",
      expression,
    );
  }
}

/** Refuse the effectful receiver method even when its receiver is aliased. */
function containsMethodCall(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMethodCall);
  if (
    typeof value !== "object" || value === null || !("op" in value) ||
    !("args" in value) || value.op === "value"
  ) return false;
  if (
    value.op === "rcall" && Array.isArray(value.args) &&
    value.args[0] === "method"
  ) return true;
  return containsMethodCall(value.args);
}

/**
 * Prepares a callable program with each direct call's checked arguments frozen
 * into it. Each call gets a private receiver, retaining its authored location.
 * The rewritten source is parsed through the public CEL API: no cached AST,
 * caller context or library-private program state is mutated.
 */
export async function prepareCheckedVaultCalls(
  env: Environment,
  analysis: VaultCallAnalysis,
  expression: string,
  bindings: Record<string, unknown>,
  bag: VaultSecretBag,
  scope: VaultEvaluationScope,
  assertFaults: () => void,
): Promise<() => unknown> {
  const local: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(bindings),
    Object.getOwnPropertyDescriptors(bindings),
  );
  let prefix = "__swamp_checked_vault_";
  while (
    expression.includes(prefix) ||
    Object.keys(local).some((key) => key.startsWith(prefix))
  ) prefix += "_";
  const replacements = new Map<VaultGetCall, string>();
  const replace = (start: number, end: number): string => {
    const edits: SourceEdit[] = [];
    // Parents cover their children; keep only the outermost prepared calls.
    const contained = [...replacements.keys()].filter((call) =>
      call.node.start >= start && call.node.end <= end
    )
      .sort((a, b) => a.node.start - b.node.start || b.node.end - a.node.end);
    let through = start;
    for (const call of contained) {
      if (call.node.start < through) continue;
      edits.push({
        start: call.node.start - start,
        end: call.node.end - start,
        text: replacements.get(call)!,
      });
      through = call.node.end;
    }
    return editCelSource(analysis.source.text.slice(start, end), edits).text;
  };
  for (const [index, call] of analysis.calls.entries()) {
    const args: string[] = [];
    for (const [position, arg] of call.args.entries()) {
      let value: unknown;
      try {
        value = await env.evaluate(
          replace(arg.node.start, arg.node.end),
          local,
        );
      } catch {
        // Faults take precedence and never carry a value. Other argument errors
        // name the authored call, never cel-js's potentially value-bearing cause.
        assertFaults();
        throw new InvalidExpressionError(
          `Failed to evaluate vault.get argument ${position + 1} at ${
            callLocation(expression, call.start, scope.location)
          }`,
          expression,
        );
      }
      assertFaults();
      if (isSecret(value)) refuse(`vault.get argument ${position + 1}`);
      if (typeof value !== "string") {
        throw new InvalidExpressionError(
          `vault.get argument ${position + 1} must resolve to a string`,
          expression,
        );
      }
      args.push(value);
    }
    const reference = { vaultName: args[0], key: args[1] };
    const location = callLocation(expression, call.start, scope.location);
    await checkSecretReference(scope.service, reference, {
      registry: bag.registry,
      redactor: scope.redactor,
      call: call.authored,
      location,
    });
    const receiver = `${prefix}${index}`;
    Object.defineProperty(local, receiver, {
      value: new CelVaultNamespace(reference, location),
      enumerable: true,
    });
    // Bound as dyn: cel-js unifies ternary branch types when it plans the
    // program, and a Secret branch beside a string literal would otherwise
    // fail where the untyped path worked (design Section 4.2, fact 9). The
    // value is still the Secret, so every refusal and allowed overload
    // dispatches on it at run time as before.
    replacements.set(
      call,
      `dyn(${receiver}.get(${JSON.stringify(reference.vaultName)}, ${
        JSON.stringify(reference.key)
      }))`,
    );
  }
  const program = env.parse(replace(0, analysis.source.text.length));
  return () => program(local);
}

/** `path:line:column` of the call at `offset` in the authored expression. */
export function callLocation(
  expression: string,
  offset: number,
  path: string,
): string {
  const preceding = expression.slice(0, offset);
  const line = preceding.split("\n").length;
  const column = offset - preceding.lastIndexOf("\n");
  return `${path}:${line}:${column}`;
}
