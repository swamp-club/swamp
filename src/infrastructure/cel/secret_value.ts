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
 * a Proxy over a frozen empty object with state in a private WeakMap; traps
 * refuse enumeration and string conversion and answer undefined elsewhere, so
 * mishandling fails instead of becoming {} or text
 */

import type { SecretReference } from "../../domain/vaults/secret_bag_registry.ts";
import { refuse } from "./secret_fault_context.ts";

/**
 * The registered constructor. cel-js decides a value's type by exact
 * constructor identity, and the proxy's `get` trap answers `constructor`
 * with this class.
 */
export class Secret {
  declare private readonly secretBrand: never;
}

export interface SecretReferencePart {
  readonly reference: SecretReference;
  readonly dataOrigin: boolean;
  readonly location?: string;
  readonly sentinel?: string;
  /**
   * set when the vault value is the JSON text of a non-string value, so
   * delivering the reference as a whole value parses it
   */
  readonly jsonValue?: true;
}

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

export function vaultReferenceSecret(
  reference: SecretReference,
  location: string,
): Secret {
  return secretFromParts([{ reference, dataOrigin: false, location }]);
}

/**
 * only the accessor adapter creates one; jsonValue marks a reference whose
 * vault value is the JSON text of a non-string value
 */
export function dataReferenceSecret(
  reference: SecretReference,
  location: string,
  jsonValue = false,
): Secret {
  return secretFromParts([
    jsonValue
      ? { reference, dataOrigin: true, location, jsonValue }
      : { reference, dataOrigin: true, location },
  ]);
}

export function isSecret(value: unknown): value is Secret {
  return typeof value === "object" && value !== null && states.has(value);
}

export function secretParts(value: unknown): readonly SecretPart[] | undefined {
  return typeof value === "object" && value !== null
    ? states.get(value)
    : undefined;
}

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
