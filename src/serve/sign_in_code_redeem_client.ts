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
  parsePrincipal,
  principalToString,
} from "../domain/access/principal.ts";
import { assertAuthenticatablePrincipal } from "../domain/access/service_principal.ts";
import type { SignInGrant } from "../domain/access/sign_in_code.ts";
import { SIGN_IN_CODE_REDEEM_PATH } from "./protocol.ts";
import { readBodyWithLimit } from "./webhook.ts";

const REDEEM_TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_NAMES = 256;
const MAX_NAME_LENGTH = 256;

export type SignInCodeRedeemOutcome =
  | { readonly ok: true; readonly grant: SignInGrant }
  /** refused: the root does not know the code for this workspace */
  | { readonly ok: false; readonly reason: "refused" }
  /** the root could not be reached, or answered something no root sends */
  | {
    readonly ok: false;
    readonly reason: "unavailable";
    readonly detail: string;
  };

export interface SignInCodeRedeemClient {
  redeem(code: string, signal?: AbortSignal): Promise<SignInCodeRedeemOutcome>;
}

export interface SignInCodeRedeemClientOptions {
  /** the root's public address, as the host passed it */
  readonly rootAddress: string;
  /** this workspace's name, which every code it redeems must be bound to */
  readonly workspace: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function names(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_NAMES) return null;
  for (const item of value) {
    if (typeof item !== "string" || item.length > MAX_NAME_LENGTH) return null;
  }
  return value as string[];
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && value.length <= MAX_NAME_LENGTH) {
    return value;
  }
  return undefined;
}

/** null for any reply a root would not send; a token is minted from what passes */
export function parseRedeemReply(body: unknown): SignInGrant | null {
  if (typeof body !== "object" || body === null) return null;
  const reply = body as Record<string, unknown>;
  if (typeof reply.principal !== "string") return null;
  let principal;
  try {
    principal = parsePrincipal(reply.principal);
    assertAuthenticatablePrincipal(principal);
  } catch {
    return null;
  }
  if (principal.kind !== "user") return null;
  const username = optionalString(reply.username);
  const email = optionalString(reply.email);
  const collectives = names(reply.collectives);
  const groups = names(reply.groups);
  if (
    username === undefined || email === undefined || collectives === null ||
    groups === null || typeof reply.expiresAt !== "string" ||
    Number.isNaN(Date.parse(reply.expiresAt))
  ) {
    return null;
  }
  return {
    principal: principalToString(principal),
    username,
    email,
    collectives: [...collectives],
    groups: [...groups],
    expiresAt: new Date(Date.parse(reply.expiresAt)).toISOString(),
  };
}

/** only the code and this workspace's name go to the root, never a token */
export function createSignInCodeRedeemClient(
  options: SignInCodeRedeemClientOptions,
): SignInCodeRedeemClient {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.rootAddress}${SIGN_IN_CODE_REDEEM_PATH}`;
  return {
    async redeem(code, signal) {
      const timeout = AbortSignal.timeout(
        options.timeoutMs ?? REDEEM_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, workspace: options.workspace }),
          redirect: "manual",
          signal: signal === undefined
            ? timeout
            : AbortSignal.any([signal, timeout]),
        });
      } catch (error) {
        return {
          ok: false,
          reason: "unavailable",
          detail: `the root at ${options.rootAddress} could not be reached: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return { ok: false, reason: "refused" };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return {
          ok: false,
          reason: "unavailable",
          detail:
            `the root at ${options.rootAddress} answered HTTP ${response.status}`,
        };
      }
      const bytes = await readBodyWithLimit(response, MAX_REPLY_BYTES);
      let grant: SignInGrant | null = null;
      if (bytes !== null) {
        try {
          grant = parseRedeemReply(JSON.parse(new TextDecoder().decode(bytes)));
        } catch {
          grant = null;
        }
      }
      if (grant === null) {
        return {
          ok: false,
          reason: "unavailable",
          detail:
            `the root at ${options.rootAddress} sent a reply no root sends`,
        };
      }
      return { ok: true, grant };
    },
  };
}
