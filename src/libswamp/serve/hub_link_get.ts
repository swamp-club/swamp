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

import type { LibSwampContext } from "../context.ts";
import type {
  HubLink,
  HubLinkInstance,
  HubLinkView,
} from "../../domain/serve/hub_link.ts";
import {
  type FederationAdminEvent,
  runFederationAdmin,
} from "./federation_admin.ts";

export interface HubLinkReader {
  readLink(): Promise<HubLink>;
  listInstances(): Promise<HubLinkInstance[]>;
}

export interface HubLinkGetDeps {
  readonly links: HubLinkReader;
  readonly configuredHubUrl: string;
}

export type HubLinkGetEvent = FederationAdminEvent<HubLinkView>;

export function hubLinkGet(
  _ctx: LibSwampContext,
  deps: HubLinkGetDeps,
): AsyncGenerator<HubLinkGetEvent> {
  return runFederationAdmin(
    "swamp.serve.hub.get",
    "hub_link_get_failed",
    async () => {
      const link = await deps.links.readLink();
      return {
        state: link.state,
        hubUrl: link.hubUrl,
        configuredHubUrl: deps.configuredHubUrl,
        hubName: link.hubName,
        memberName: link.memberName,
        memberId: link.memberId,
        joinedAt: link.joinedAt,
        instances: await deps.links.listInstances(),
      };
    },
  );
}
