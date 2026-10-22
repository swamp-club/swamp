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

import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
  SWAMP_OWNED_DIR_NAMES,
} from "../datastore/datastore_config.ts";
import { wordedError, wordedText } from "../behavior_wording.ts";

export type Namespace = string & { readonly _brand: unique symbol };

const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAMESPACE_MAX_LENGTH = 64;

/**
 * Names a namespace cannot take because swamp already uses them as
 * directories. A namespace is the outermost segment of the datastore tier
 * (`{base}/{namespace}/{subdir}/...`), so one named after a layout directory
 * shares a directory with the solo layout (`{base}/{subdir}/...`); and a v3
 * checkout materialises it at `.swamp/{namespace}/`, so one named after any
 * directory swamp keeps in `.swamp/` would be written over swamp's own files
 * (swamp-club#3691). Built from {@link SWAMP_OWNED_DIR_NAMES}, which holds the
 * layout constants, so a directory added there is reserved with it.
 */
export const RESERVED_NAMESPACE_NAMES: ReadonlySet<string> = new Set<string>(
  SWAMP_OWNED_DIR_NAMES,
);

export function isReservedNamespaceName(slug: string): boolean {
  return RESERVED_NAMESPACE_NAMES.has(slug);
}

/**
 * The reserved names that are directories of the datastore layout, the set
 * reserved before swamp-club#3691. Only these share a directory with the
 * solo layout on v2 (`{base}/{subdir}/...`), so only these make an existing
 * v2 binding's data impossible to tell apart. A v2 repository already bound
 * to another reserved name keeps working; the wider set applies to new
 * claims ({@link createNamespace}) and to v3.
 */
const LAYOUT_NAMESPACE_NAMES: ReadonlySet<string> = new Set<string>([
  ...DEFAULT_DATASTORE_SUBDIRS,
  ...ALWAYS_LOCAL_SUBDIRS,
]);

/**
 * True when a namespace slug names a directory of the datastore layout:
 * a layout name, or one of the repo's configured datastore directories.
 * The v2 gates on an existing binding use it.
 */
export function namespaceCollidesWithLayout(
  slug: string,
  datastoreDirectories: Iterable<string>,
): boolean {
  if (LAYOUT_NAMESPACE_NAMES.has(slug)) return true;
  for (const dir of datastoreDirectories) {
    if (dir === slug) return true;
  }
  return false;
}

/**
 * The opening of every message about a namespace that shares its name with
 * a directory swamp uses (swamp-club#3691): the v2 move-it-by-hand steps and
 * the v3 refusal both start with it.
 */
export function namespaceNameClash(namespace: string): string {
  return `Namespace ${
    JSON.stringify(namespace)
  } has the same name as a datastore layout directory or a directory swamp keeps in .swamp/`;
}

/**
 * Why a v3 checkout refuses to open on a reserved namespace, and the one way
 * off it that works on v3 (swamp-club#3691): `namespace set` and `datastore
 * setup` both refuse on a v3 repository, so the repository's datastore
 * config is edited by hand and pointed at a new, empty v3 datastore.
 */
export function reservedV3NamespaceMessage(namespace: string): string {
  return `${namespaceNameClash(namespace)}. A v3 checkout keeps namespace ` +
    `${JSON.stringify(namespace)}'s records in .swamp/${namespace}/, over ` +
    `swamp's own files, so it does not open on this namespace. Nothing was ` +
    `changed.\n\n` +
    `A v3 repository cannot change its namespace in place. To go on:\n` +
    `  1. Set up a new, empty v3 datastore, for example from a new ` +
    `repository with 'swamp datastore setup filesystem --path <dir> ` +
    `--format 3'\n` +
    `  2. In this repository's .swamp.yaml, set the datastore's ` +
    `\`namespace\` to a name that is not reserved and point the datastore ` +
    `at the new one\n` +
    `Nothing is migrated: the records committed under ` +
    `${JSON.stringify(namespace)} stay in the current datastore.`;
}

function assertNamespaceShape(slug: string): void {
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
}

/**
 * Creates a namespace a repo is about to claim. Rejects reserved names.
 */
export function createNamespace(slug: string): Namespace {
  assertNamespaceShape(slug);
  if (isReservedNamespaceName(slug)) {
    throw new Error(
      `Namespace ${
        JSON.stringify(slug)
      } is reserved: it is a directory of the datastore layout or of swamp's .swamp/ directory`,
    );
  }
  return slug as Namespace;
}

/**
 * Rebuilds a namespace already stored in a repo's config. Unlike
 * {@link createNamespace} it accepts a reserved name, so a repo bound to one
 * before the name was reserved still loads.
 */
export function restoreNamespace(slug: string): Namespace {
  assertNamespaceShape(slug);
  return slug as Namespace;
}

export const SOLO_NAMESPACE: Namespace = "" as Namespace;

export function isEmptyNamespace(ns: Namespace): boolean {
  return ns === "";
}

/**
 * Who reads a row, for deciding whether the row is the reader's own: the
 * reader's namespace, and whether it reads the solo namespace as another
 * namespace, as a v3 checkout does (swamp-club#3691).
 */
export interface NamespaceReader {
  readonly namespace: string;
  readonly readsSoloNamespace: boolean;
}

/**
 * Whether a row of `namespace` is another namespace's to `reader`. A row of
 * the reader's namespace is its own. A solo row (`""`) in a namespaced
 * repository was written before the repository set a namespace, so it is
 * the reader's own too, unless the reader reads the solo namespace as
 * another namespace. A catalog pull never stores a solo row, so only the
 * repository's own writes leave one.
 */
export function isForeignToReader(
  namespace: string,
  reader: NamespaceReader,
): boolean {
  if (namespace === reader.namespace) return false;
  return namespace !== "" || reader.readsSoloNamespace;
}

export interface NamespacedModelName {
  readonly namespace: string | undefined;
  readonly modelName: string;
}

export function parseNamespacedModelName(input: string): NamespacedModelName {
  if (input === "") {
    throw wordedError(
      wordedText((w) => `Invalid namespaced ${w.noun} name: input is empty`),
    );
  }

  const colonIndex = input.indexOf(":");
  if (colonIndex === -1) {
    return { namespace: undefined, modelName: input };
  }

  const namespace = input.slice(0, colonIndex);
  const modelName = input.slice(colonIndex + 1);

  if (modelName === "") {
    throw wordedError(
      wordedText((w) =>
        `Invalid namespaced ${w.noun} name: ${w.noun} name is empty in ${
          JSON.stringify(input)
        }`
      ),
    );
  }

  if (namespace === "") {
    return { namespace: undefined, modelName };
  }

  return { namespace, modelName };
}

export function formatNamespacedModelName(
  namespace: string | undefined,
  modelName: string,
): string {
  if (namespace === undefined || namespace === "") return modelName;
  return `${namespace}:${modelName}`;
}
