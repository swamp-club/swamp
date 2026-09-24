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

import type { ExtensionLookupPort } from "../domain/extensions/extension_auto_resolver.ts";
import type { ClientIdentity } from "../infrastructure/http/client_identity.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";

/**
 * A registry lookup port backed by the extension API, the same lookup the
 * auto-resolver uses. Extension commands pass it to recognise the datastore
 * extension when the managed config base is unresolved.
 */
export function createExtensionRegistryLookup(
  serverUrl: string,
  identity: ClientIdentity,
): ExtensionLookupPort {
  const client = new ExtensionApiClient(serverUrl, identity);
  const apiKey = identity.bearerToken;
  return {
    getExtension: (name) => client.getExtension(name, apiKey),
    searchExtensions: (params) => client.searchExtensions(params, apiKey),
  };
}
