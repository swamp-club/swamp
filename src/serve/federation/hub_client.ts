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

import { z } from "zod";
import type { Fingerprint } from "../../domain/serve/fingerprint.ts";
import { normalizedUuid } from "../../domain/serve/instance_id.ts";
import {
  MemberCredential,
  MemberCredentialError,
} from "../../domain/serve/member_credential.ts";
import {
  FEDERATION_CHECK_IN_PATH,
  FEDERATION_JOIN_PATH,
  FEDERATION_PROTOCOL_VERSION,
  MAX_FEDERATION_BODY_BYTES,
} from "./hub_routes.ts";

export const HUB_REQUEST_TIMEOUT_MS = 10_000;

const NAME = z.string().min(1).max(128);

const HubIdentitySchema = z.object({
  name: NAME,
  swampVersion: z.string().max(64),
  protocolVersion: z.number(),
});

// success replies only; unknown keys are dropped so a later hub may add some
const JoinReplySchema = z.object({
  memberId: z.string().max(64),
  memberName: NAME,
  credential: z.string().max(512),
  hub: HubIdentitySchema,
  checkInIntervalSeconds: z.number(),
});

const CheckInReplySchema = z.object({
  hub: HubIdentitySchema,
  checkInIntervalSeconds: z.number(),
});

export type HubIdentityReply = z.infer<typeof HubIdentitySchema>;

export interface JoinReply {
  readonly memberId: string;
  readonly memberName: string;
  readonly credential: MemberCredential;
  readonly hub: HubIdentityReply;
  readonly checkInIntervalSeconds: number;
}

export interface CheckInReply {
  readonly hub: HubIdentityReply;
  readonly checkInIntervalSeconds: number;
}

/** only a successful join's value carries a credential; no failure carries it or the token */
export type HubOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "conflict"; readonly error: string }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds?: number }
  | { readonly kind: "server_error"; readonly status: number }
  | { readonly kind: "rejected"; readonly status: number }
  | { readonly kind: "unreachable" }
  | { readonly kind: "stopped" };

export interface HubClientOptions {
  /** normalised without a trailing slash, as serve.yaml validation leaves it */
  readonly hubUrl: string;
  /** --ca-cert's roots beside the process-wide store; TLS is always verified */
  readonly caCerts?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly createClient?: (
    options: Deno.CreateHttpClientOptions,
  ) => Deno.HttpClient;
  readonly timeoutMs?: number;
}

/** speaks /federation/v1 to the one hub serve.yaml names */
export class HubClient {
  readonly #options: HubClientOptions;
  readonly #stopped = new AbortController();
  #client: Deno.HttpClient | undefined;

  constructor(options: HubClientOptions) {
    this.#options = options;
  }

  async join(
    joinToken: string,
    fingerprint: Fingerprint,
  ): Promise<HubOutcome<JoinReply>> {
    const outcome = await this.#post(FEDERATION_JOIN_PATH, {
      joinToken,
      fingerprint: fingerprint.toJSON(),
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      capabilities: [],
    });
    if (outcome.kind !== "ok") return outcome;
    const reply = JoinReplySchema.safeParse(outcome.value);
    if (!reply.success) return { kind: "rejected", status: 200 };
    const joined = joinReplyOf(reply.data);
    return joined === undefined
      ? { kind: "rejected", status: 200 }
      : { kind: "ok", value: joined };
  }

  async checkIn(
    credential: MemberCredential,
    instanceId: string,
    fingerprint: Fingerprint,
  ): Promise<HubOutcome<CheckInReply>> {
    const outcome = await this.#post(FEDERATION_CHECK_IN_PATH, {
      instanceId,
      fingerprint: fingerprint.toJSON(),
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      capabilities: [],
    }, credential);
    if (outcome.kind !== "ok") return outcome;
    const reply = CheckInReplySchema.safeParse(outcome.value);
    return reply.success
      ? { kind: "ok", value: reply.data }
      : { kind: "rejected", status: 200 };
  }

  dispose(): void {
    this.#stopped.abort();
    this.#client?.close();
    this.#client = undefined;
  }

  async #post(
    path: string,
    body: Record<string, unknown>,
    credential?: MemberCredential,
  ): Promise<HubOutcome<unknown>> {
    if (this.#stopped.signal.aborted) return { kind: "stopped" };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (credential !== undefined) {
      headers.authorization = `Bearer ${credential.toWire()}`;
    }
    const signal = AbortSignal.any([
      this.#stopped.signal,
      AbortSignal.timeout(this.#options.timeoutMs ?? HUB_REQUEST_TIMEOUT_MS),
    ]);
    const client = this.#httpClient();
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(
        `${this.#options.hubUrl}${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          // a redirect would carry the credential to another location
          redirect: "manual",
          signal,
          ...(client !== undefined ? { client } : {}),
        } as RequestInit,
      );
    } catch {
      return this.#stopped.signal.aborted
        ? { kind: "stopped" }
        : { kind: "unreachable" };
    }
    try {
      return await outcomeOf(response, signal);
    } catch {
      return this.#stopped.signal.aborted
        ? { kind: "stopped" }
        : { kind: "unreachable" };
    }
  }

  #httpClient(): Deno.HttpClient | undefined {
    const caCerts = this.#options.caCerts;
    if (caCerts === undefined || caCerts.length === 0) return undefined;
    this.#client ??= (this.#options.createClient ?? Deno.createHttpClient)({
      caCerts: [...caCerts],
    });
    return this.#client;
  }
}

function joinReplyOf(reply: z.infer<typeof JoinReplySchema>):
  | JoinReply
  | undefined {
  const memberId = normalizedUuid(reply.memberId);
  if (memberId === undefined || memberId !== reply.memberId) return undefined;
  let credential: MemberCredential;
  try {
    credential = MemberCredential.parse(reply.credential);
  } catch (error) {
    if (error instanceof MemberCredentialError) return undefined;
    throw error;
  }
  if (credential.memberId !== memberId) return undefined;
  return {
    memberId,
    memberName: reply.memberName,
    credential,
    hub: reply.hub,
    checkInIntervalSeconds: reply.checkInIntervalSeconds,
  };
}

async function outcomeOf(
  response: Response,
  signal: AbortSignal,
): Promise<HubOutcome<unknown>> {
  const status = response.status;
  if (status !== 200) {
    await response.body?.cancel();
    if (status === 401) return { kind: "unauthorized" };
    if (status === 429) {
      return {
        kind: "rate_limited",
        ...retryAfter(response.headers.get("retry-after")),
      };
    }
    if (status === 409) return { kind: "conflict", error: "conflict" };
    if (status >= 500) return { kind: "server_error", status };
    return { kind: "rejected", status };
  }
  const bytes = await readCapped(response, signal);
  if (bytes === undefined) return { kind: "rejected", status };
  try {
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: "rejected", status };
  }
}

function retryAfter(header: string | null): { retryAfterSeconds?: number } {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return {};
  return { retryAfterSeconds: Number(header.trim()) };
}

// a hub reply is at most what a hub accepts; past that the rest is not read
async function readCapped(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEDERATION_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
