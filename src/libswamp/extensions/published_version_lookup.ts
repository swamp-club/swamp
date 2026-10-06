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

import type { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { PublishedVersion } from "../../domain/extensions/extension_publish_checks.ts";

/** Release channels a version may be published on. */
const ALL_RELEASE_CHANNELS = ["stable", "rc", "beta"];
const VERSIONS_PAGE_SIZE = 100;
const VERSIONS_MAX_PAGES = 50;

/**
 * Finds a published version of an extension on any release channel, or null
 * when no channel carries it. Push and promote both ask through here, with a
 * client each builds the same way, so they agree on where a version lives.
 */
export async function findPublishedVersion(
  client: Pick<ExtensionApiClient, "listVersions">,
  name: string,
  version: string,
  apiKey: string,
): Promise<PublishedVersion | null> {
  // A version is unique per extension across channels, so every channel
  // is asked and the first match on any of them answers.
  for (let page = 1; page <= VERSIONS_MAX_PAGES; page++) {
    const listed = await client.listVersions(name, {
      channel: ALL_RELEASE_CHANNELS,
      perPage: VERSIONS_PAGE_SIZE,
      page,
    }, apiKey);
    const match = listed.versions.find((v) => v.version === version);
    if (match) return { version: match.version, channel: match.channel };
    // A short page is the last page; so is reaching the total. A
    // response without usable paging metadata is not paged further.
    const perPage = listed.meta?.perPage;
    const total = listed.meta?.total;
    const seen = (page - 1) * perPage + listed.versions.length;
    if (
      listed.versions.length === 0 || !Number.isFinite(seen) ||
      listed.versions.length < perPage || seen >= total
    ) {
      return null;
    }
  }
  return null;
}
