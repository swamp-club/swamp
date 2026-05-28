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

export type Namespace = string & { readonly _brand: unique symbol };

const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAMESPACE_MAX_LENGTH = 64;

export function createNamespace(slug: string): Namespace {
  if (slug.length === 0) {
    throw new Error("Namespace cannot be empty — use SOLO_NAMESPACE instead");
  }
  if (slug.length > NAMESPACE_MAX_LENGTH) {
    throw new Error(
      `Namespace must be at most ${NAMESPACE_MAX_LENGTH} characters, got ${slug.length}`,
    );
  }
  if (!NAMESPACE_PATTERN.test(slug)) {
    throw new Error(
      `Namespace must match [a-z0-9][a-z0-9-]*: ${JSON.stringify(slug)}`,
    );
  }
  return slug as Namespace;
}

export const SOLO_NAMESPACE: Namespace = "" as Namespace;

export function isEmptyNamespace(ns: Namespace): boolean {
  return ns === "";
}

export interface NamespacedModelName {
  readonly namespace: string | undefined;
  readonly modelName: string;
}

export function parseNamespacedModelName(input: string): NamespacedModelName {
  if (input === "") {
    throw new Error("Invalid namespaced model name: input is empty");
  }

  const colonIndex = input.indexOf(":");
  if (colonIndex === -1) {
    return { namespace: undefined, modelName: input };
  }

  const namespace = input.slice(0, colonIndex);
  const modelName = input.slice(colonIndex + 1);

  if (modelName === "") {
    throw new Error(
      `Invalid namespaced model name: model name is empty in ${
        JSON.stringify(input)
      }`,
    );
  }

  if (namespace === "") {
    return { namespace: undefined, modelName };
  }

  return { namespace, modelName };
}
