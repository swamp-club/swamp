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

import fc from "fast-check";
import { normalizeServerUrl } from "../auth/server_url.ts";
import {
  hostedWorkspaceAddress,
  splitWorkspaceAddress,
} from "./workspace_address.ts";

const arbName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,62}$/);
const arbSegment = fc.stringMatching(/^[a-z0-9_-]{1,12}$/);
const arbHost = fc.tuple(
  fc.constantFrom("http", "https"),
  // URL parsing refuses an xn-- label unless it is valid punycode
  fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter((label) =>
    !label.startsWith("xn--")
  ),
  fc.option(fc.integer({ min: 1024, max: 65535 }), { nil: undefined }),
  fc.array(arbSegment, { maxLength: 3 }),
).map(([scheme, host, port, path]) =>
  normalizeServerUrl(
    `${scheme}://${host}.example${port === undefined ? "" : `:${port}`}${
      path.map((segment) => `/${segment}`).join("")
    }`,
  )
);

Deno.test("splitWorkspaceAddress: recovers the host and name a hosted address was built from", () => {
  fc.assert(
    fc.property(arbHost, arbName, (host, name) => {
      const split = splitWorkspaceAddress(
        normalizeServerUrl(hostedWorkspaceAddress(host, name)),
      );
      return split !== null && split.hostAddress === host &&
        split.name === name;
    }),
  );
});

Deno.test("splitWorkspaceAddress: the host it names is always the address with the workspace segment removed", () => {
  fc.assert(
    fc.property(fc.webUrl(), (raw) => {
      let address: string;
      try {
        address = normalizeServerUrl(raw);
      } catch {
        return true;
      }
      const split = splitWorkspaceAddress(address);
      return split === null ||
        hostedWorkspaceAddress(split.hostAddress, split.name) === address;
    }),
  );
});
