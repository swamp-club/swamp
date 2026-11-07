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
 * no v3 imports, so the binding, the datastore handle and the replica lookup
 * can all ask it without an import cycle
 */

import { resolve } from "@std/path";
import type {
  ServeInitiatorMode,
  ServeUpstreamTarget,
} from "../../domain/datastore_v3/serve_upstream.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";

export interface ServeUpstreamBinding {
  readonly root: string;
  readonly target: ServeUpstreamTarget;
  readonly namespace: string;
  readonly client: () => ServeDatastoreClient;
}

const bindings = new Map<string, ServeUpstreamBinding>();

// what this process last learned from serve, or what the checkout stored
const initiators = new Map<string, ServeInitiatorMode>();

export function noteServeInitiator(
  datastorePath: string,
  mode: ServeInitiatorMode,
): void {
  initiators.set(resolve(datastorePath), mode);
}

/** undefined: not heard from serve since this swamp was upgraded */
export function serveInitiatorAt(
  datastorePath: string,
): ServeInitiatorMode | undefined {
  return initiators.get(resolve(datastorePath));
}

export function registerServeUpstream(
  binding: ServeUpstreamBinding,
): ServeUpstreamBinding {
  const root = resolve(binding.root);
  const known = bindings.get(root);
  if (known !== undefined) return known;
  bindings.set(root, binding);
  return binding;
}

export function serveUpstreamAt(
  datastorePath: string,
): ServeUpstreamBinding | undefined {
  return bindings.get(resolve(datastorePath));
}

export function hasServeUpstream(): boolean {
  return bindings.size > 0;
}

export function resetServeUpstreamBindingsForTesting(): void {
  bindings.clear();
  initiators.clear();
}
