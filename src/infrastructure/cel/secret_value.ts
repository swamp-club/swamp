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
 * The `Secret` value of the CEL adapter (design/enablers/typed-secrets.md
 * Section 3.1). It holds where a secret lives, never the secret:
 *
 * - Each instance is a Proxy over one frozen, empty `Secret` object. Its
 *   state lives in a module-private WeakMap keyed by the proxy, so nothing
 *   reads it through the object.
 * - `ownKeys` and `getOwnPropertyDescriptor` refuse. The `get` trap answers
 *   `constructor`, returns refusing functions for `toString`, `toJSON`,
 *   `valueOf` and `Symbol.toPrimitive`, and answers `undefined` for every
 *   other key, `then` included, so awaiting a `Secret` or inspecting it is
 *   harmless. Code that mishandles a `Secret` fails instead of turning it
 *   into `{}` or text, and each refusal records a fault first.
 * - Only this module's functions create instances, and nothing recognizes a
 *   `Secret` by its shape.
 *
 * No code outside the CEL adapter sees a `Secret`: the boundary conversion
 * (`secret_boundary.ts`) turns each one into its sentinel as it leaves CEL.
 * Compare two secrets with `assertStrictEquals` or {@link secretParts}:
 * `assertEquals` walks their keys and trips the `ownKeys` trap.
 */

import type { SecretReference } from "../../domain/vaults/secret_bag_registry.ts";
import { refuse } from "./secret_fault_context.ts";

/**
 * The registered constructor. cel-js decides a value's type by exact
 * constructor identity, and the proxy's `get` trap answers `constructor`
 * with this class.
 */
export class Secret {
  /** A type-only brand, so a type guard can tell a `Secret` from `{}`. */
  declare private readonly secretBrand: never;
}

/** One reference a `Secret` holds. */
export interface SecretReferencePart {
  readonly reference: SecretReference;
  /** True when the secret reached CEL through a data read. */
  readonly dataOrigin: boolean;
  /** Where the author wrote the reference, for a load's errors. */
  readonly location?: string;
  /** The sentinel the reference entered CEL as, which it leaves as. */
  readonly sentinel?: string;
}

/** A part of a `Secret`: text, or a reference. */
export type SecretPart = string | SecretReferencePart;

const states = new WeakMap<object, readonly SecretPart[]>();
const TARGET = Object.freeze(new Secret()) as Secret;
const THROWING_KEYS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  "toString",
  "toJSON",
  "valueOf",
  Symbol.toPrimitive,
]);

const handler: ProxyHandler<Secret> = {
  ownKeys() {
    return refuse("ownKeys");
  },
  getOwnPropertyDescriptor() {
    return refuse("getOwnPropertyDescriptor");
  },
  get(_target, key) {
    if (key === "constructor") return Secret;
    if (THROWING_KEYS.has(key)) return () => refuse(String(key));
    return undefined;
  },
};

/**
 * A `Secret` holding `parts`, with adjacent text joined and empty text
 * dropped. At least one part must be a reference.
 */
export function secretFromParts(parts: readonly SecretPart[]): Secret {
  const joined: SecretPart[] = [];
  for (const part of parts) {
    const last = joined[joined.length - 1];
    if (typeof part === "string") {
      if (part === "") continue;
      if (typeof last === "string") joined[joined.length - 1] = last + part;
      else joined.push(part);
    } else {
      // A part keeps its identity across compositions, so the boundary
      // issues one sentinel for it however often it recurs.
      joined.push(Object.isFrozen(part) ? part : Object.freeze({ ...part }));
    }
  }
  if (!joined.some((part) => typeof part !== "string")) {
    throw new Error("A secret holds at least one reference");
  }
  const proxy = new Proxy(TARGET, handler);
  states.set(proxy, Object.freeze(joined));
  return proxy;
}

/** A `Secret` holding one vault reference, written at `location`. */
export function vaultReferenceSecret(
  reference: SecretReference,
  location: string,
): Secret {
  return secretFromParts([{ reference, dataOrigin: false, location }]);
}

/** Whether `value` is a `Secret` this module created. */
export function isSecret(value: unknown): value is Secret {
  return typeof value === "object" && value !== null && states.has(value);
}

/** The parts behind a `Secret`, or undefined for any other value. */
export function secretParts(value: unknown): readonly SecretPart[] | undefined {
  return typeof value === "object" && value !== null
    ? states.get(value)
    : undefined;
}

/**
 * Concatenation, the allowed set's one operation that builds a value: the
 * parts of `a` then the parts of `b`, each a `Secret` or text.
 */
export function composeSecrets(
  a: Secret | string,
  b: Secret | string,
): Secret {
  return secretFromParts([...partsOf(a), ...partsOf(b)]);
}

function partsOf(value: Secret | string): readonly SecretPart[] {
  if (typeof value === "string") return [value];
  const parts = secretParts(value);
  if (parts === undefined) throw new Error("Not a secret");
  return parts;
}
