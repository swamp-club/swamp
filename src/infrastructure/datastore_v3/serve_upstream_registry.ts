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
 * The serve-upstream bindings of this process (swamp-club#3985): which v3
 * local roots are a checkout's follower copy of a datastore written through
 * serve, and the client each talks to serve with. A module of its own with
 * no v3 imports, so the binding, the datastore handle and the replica
 * lookup can all ask it without an import cycle.
 *
 * @module
 */

import { resolve } from "@std/path";
import type { ServeUpstreamTarget } from "../../domain/datastore_v3/serve_upstream.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";

/** A v3 local root whose upstream is serve. */
export interface ServeUpstreamBinding {
  /** The local root: the follower copy and the chunk cache live under it. */
  readonly root: string;
  readonly target: ServeUpstreamTarget;
  /** The datastore's namespace, as the checkout's config names it. */
  readonly namespace: string;
  /** Opens a client onto serve's datastore API for this datastore. */
  readonly client: () => ServeDatastoreClient;
}

const bindings = new Map<string, ServeUpstreamBinding>();

/** Records `binding` for its root; a second binding of a root keeps the first. */
export function registerServeUpstream(
  binding: ServeUpstreamBinding,
): ServeUpstreamBinding {
  const root = resolve(binding.root);
  const known = bindings.get(root);
  if (known !== undefined) return known;
  bindings.set(root, binding);
  return binding;
}

/** The serve-upstream binding of the v3 local root `datastorePath`, if any. */
export function serveUpstreamAt(
  datastorePath: string,
): ServeUpstreamBinding | undefined {
  return bindings.get(resolve(datastorePath));
}

/** Whether any datastore this process opened is written through serve. */
export function hasServeUpstream(): boolean {
  return bindings.size > 0;
}

/** Test seam: forgets every serve-upstream binding of this process. */
export function resetServeUpstreamBindingsForTesting(): void {
  bindings.clear();
}
