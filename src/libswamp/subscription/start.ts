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
  type AuthCredentials,
  DEFAULT_SWAMP_CLUB_URL,
} from "../../domain/auth/auth_credentials.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { billingUrl } from "./status.ts";

export interface SubscriptionStartInput {
  /** Open this collective's billing page instead of the user's own. */
  collective?: string;
  /** Hand back the URL without opening a browser. */
  noBrowser: boolean;
}

/** Whether a browser was opened, not asked for, or would not open. */
export type SubscriptionStartBrowser = "opened" | "skipped" | "failed";

export interface SubscriptionStartResult {
  url: string;
  collective: string | null;
  browser: SubscriptionStartBrowser;
}

// Nothing here fails today: the auth gate has already vetted the credential
// and a browser that will not open is an outcome. `error` is part of the
// union because every libswamp stream carries both terminals.
export type SubscriptionStartEvent =
  | { kind: "opening_browser"; url: string }
  | { kind: "completed"; result: SubscriptionStartResult }
  | { kind: "error"; error: SwampError };

/** Dependencies for {@link subscriptionStart}, injected for testability. */
export interface SubscriptionStartDeps {
  resolveServerUrl: () => Promise<string>;
  /** Resolves false, never rejects, when no browser could be opened. */
  openBrowser: (url: string) => Promise<boolean>;
}

export interface CreateSubscriptionStartDepsOptions {
  loadCredentials?: () => Promise<AuthCredentials | null>;
}

/**
 * Wires real infrastructure into SubscriptionStartDeps. The server is
 * SWAMP_CLUB_URL, else the stored credential's server, else the default.
 */
export function createSubscriptionStartDeps(
  options: CreateSubscriptionStartDepsOptions = {},
): SubscriptionStartDeps {
  const loadCredentials = options.loadCredentials ??
    (() => new AuthRepository().load());
  return {
    resolveServerUrl: async () => {
      const override = Deno.env.get("SWAMP_CLUB_URL");
      if (override) return override;
      const credentials = await loadCredentials();
      return credentials?.serverUrl || DEFAULT_SWAMP_CLUB_URL;
    },
    openBrowser: async (url: string): Promise<boolean> => {
      try {
        await openBrowser(url);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Opens the Swamp Club billing page, or a collective's. A browser that will
 * not open is an outcome, not an error: the URL is the result either way.
 * The slug is not checked against the user's memberships — the billing page
 * decides what the user may manage.
 */
export async function* subscriptionStart(
  _ctx: LibSwampContext,
  deps: SubscriptionStartDeps,
  input: SubscriptionStartInput,
): AsyncIterable<SubscriptionStartEvent> {
  const serverUrl = await deps.resolveServerUrl();
  const url = billingUrl(serverUrl, input.collective);
  const collective = input.collective || null;

  if (input.noBrowser) {
    yield {
      kind: "completed",
      result: { url, collective, browser: "skipped" },
    };
    return;
  }

  yield { kind: "opening_browser", url };
  const opened = await deps.openBrowser(url);
  yield {
    kind: "completed",
    result: { url, collective, browser: opened ? "opened" : "failed" },
  };
}
