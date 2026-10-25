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
  type AuthWhoamiEvent,
  rollUpPlanName,
} from "../../libswamp/auth/whoami.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { redactServerUrl } from "../../domain/auth/server_url.ts";
import { bold, cyan } from "@std/fmt/colors";
import { collectiveLines } from "./collective_standing.ts";

export interface AuthWhoamiRendererOptions {
  effectiveServeUrl?: string;
}

class LogAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  constructor(private readonly options: AuthWhoamiRendererOptions) {}

  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        if (e.identity.collectiveToken) {
          writeOutput(
            `Collective token: ${e.identity.collectiveSlug} on ${e.identity.serverUrl}`,
          );
          if (e.identity.scopes && e.identity.scopes.length > 0) {
            writeOutput(`Scopes: ${e.identity.scopes.join(", ")}`);
          }
        } else {
          writeOutput(
            `${e.identity.username} (${e.identity.email}) on ${e.identity.serverUrl}`,
          );
        }

        if (e.identity.fingerprint) {
          writeOutput(`Fingerprint: ${e.identity.fingerprint}`);
        }

        if (this.options.effectiveServeUrl) {
          writeOutput(`Serve: ${this.options.effectiveServeUrl}`);
        }

        const entitlements = e.identity.collectiveEntitlements;
        if (entitlements && entitlements.length > 0) {
          const planName = rollUpPlanName(e.identity);
          if (planName) {
            writeOutput(`${bold(cyan("Plan:"))} ${bold(planName)}`);
          }
          writeOutput(cyan("Collectives:"));
          writeOutput(collectiveLines(entitlements).join("\n"));
          return;
        }

        // No entitlement from this server — an older or self-hosted
        // swamp-club. Fall back to the exact output shipped before this
        // existed, so upgrading the CLI alone changes nothing.
        if (e.identity.collectives && e.identity.collectives.length > 0) {
          writeOutput(`Collectives: ${e.identity.collectives.join(", ")}`);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  constructor(private readonly options: AuthWhoamiRendererOptions) {}

  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            authenticated: true,
            serverUrl: e.identity.serverUrl,
            ...(this.options.effectiveServeUrl
              ? { effectiveServeUrl: this.options.effectiveServeUrl }
              : {}),
            ...(e.identity.collectiveToken
              ? {
                collectiveToken: true,
                collectiveSlug: e.identity.collectiveSlug,
                scopes: e.identity.scopes,
              }
              : {
                id: e.identity.id,
                username: e.identity.username,
                email: e.identity.email,
                name: e.identity.name,
              }),
            ...(e.identity.fingerprint
              ? { fingerprint: e.identity.fingerprint }
              : {}),
            ...(e.identity.collectives
              ? { collectives: e.identity.collectives }
              : {}),
            // Passed through verbatim, trial included regardless of plan —
            // log mode hides a paid collective's trial, but --json is what
            // gets pasted into a billing-triage report and must stay complete.
            ...(e.identity.plan ? { plan: e.identity.plan } : {}),
            ...(e.identity.collectiveEntitlements
              ? { collectiveEntitlements: e.identity.collectiveEntitlements }
              : {}),
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createAuthWhoamiRenderer(
  mode: OutputMode,
  rawOptions: AuthWhoamiRendererOptions = {},
): Renderer<AuthWhoamiEvent> {
  // The serve URL can come from SWAMP_SERVE_URL or .swamp.yaml and may carry
  // a credential; both modes show only its redacted form, or nothing.
  const options: AuthWhoamiRendererOptions = {
    ...rawOptions,
    effectiveServeUrl: rawOptions.effectiveServeUrl === undefined
      ? undefined
      : redactServerUrl(rawOptions.effectiveServeUrl),
  };
  switch (mode) {
    case "json":
      return new JsonAuthWhoamiRenderer(options);
    case "log":
      return new LogAuthWhoamiRenderer(options);
  }
}
