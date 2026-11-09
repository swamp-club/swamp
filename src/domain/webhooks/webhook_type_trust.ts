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

import type { WebhookTypeOrigin } from "./webhook_type_registry.ts";

export type WebhookTypeTrust =
  | { readonly trusted: true }
  | { readonly trusted: false; readonly collective: string };

function collectiveOf(scopedName: string): string | undefined {
  const match = /^@([^/]+)\//.exec(scopedName);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * a local source is the repo's own code and always trusted; a pulled one, or
 * one of unknown origin, needs the scheme's collective and its owning
 * extension's collective on the trust list, whatever was pulled or pinned
 */
export function evaluateWebhookTypeTrust(
  scheme: string,
  origin: WebhookTypeOrigin | undefined,
  trustedCollectives: readonly string[],
): WebhookTypeTrust {
  if (origin?.kind === "local") return { trusted: true };
  const trusted = new Set(trustedCollectives.map((c) => c.toLowerCase()));
  const owner = origin?.extensionName;
  const required = [
    collectiveOf(scheme) ?? scheme.toLowerCase(),
    ...(owner === undefined
      ? []
      : [collectiveOf(owner) ?? owner.toLowerCase()]),
  ];
  const untrusted = required.find((c) => !trusted.has(c));
  return untrusted === undefined
    ? { trusted: true }
    : { trusted: false, collective: untrusted };
}

export function untrustedWebhookSchemeMessage(
  route: string,
  scheme: string,
  collective: string,
): string {
  return `Webhook ${route} uses scheme '${scheme}' from collective ` +
    `'${collective}', which this repository does not trust. Run ` +
    `'swamp extension trust add ${collective}', then restart serve or run ` +
    `'swamp serve reload'.`;
}
