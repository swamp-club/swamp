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

import type { TokenAdmissionChecker } from "../src/serve/token_admission.ts";
import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import { DelegationDirectory } from "../src/domain/access/delegation_directory.ts";
import { generateIntegrationCredential } from "../src/domain/access/integration_credential.ts";
import type {
  IntegrationCredentialRecord,
  IntegrationDirectory,
  IntegrationStanding,
} from "../src/domain/access/integration_directory.ts";
import type { DelegationCapability } from "../src/serve/delegation_capability_check.ts";
import { DelegationLinkService } from "../src/serve/delegation_link_service.ts";
import {
  type DelegationAuditRecord,
  type DelegationRouteDeps,
  handleDelegationRequest,
  matchDelegationRoute,
} from "../src/serve/delegation_routes.ts";
import { DelegationStore } from "../src/serve/delegation_store.ts";
import { createRecordLock } from "../src/serve/deps.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { ServeLinkClient } from "../src/serve/serve_link_client.ts";
import { type ServeRepo, withServeRepo } from "./serve_request_harness.ts";

export const CEILING = Ceiling.parse({
  version: 1,
  ceiling: [{ actions: ["read", "run"], resource: "workflow:deploy" }],
});

export const IDENTITY = {
  sub: "person-1",
  email: "pat@example.com",
  username: "pat",
  collectives: ["skunk-ape"],
  groups: [],
};

export class MockClub {
  status: string = "pending";
  identity: typeof IDENTITY | undefined = IDENTITY;
  digest = "digest-1";
  reports = 0;
  statusPolls = 0;
  recordedLinks = new Set<string>();
  ends: string[] = [];
  failNextReportAfterRecording = false;
  starts = 0;
  /** served as the feed, in the order swamp-club ended them */
  endedFeed: string[] = [];
  people = new Map<string, unknown>();
  refuseClient: { status: number; error: string } | undefined;
  /** swamp-club's answer for a collective without a trial or paid plan */
  refusePlan:
    | { at: "capabilities" | "start"; message?: unknown }
    | undefined;
  down = false;
  feedCursors: (string | null)[] = [];
  #server: Deno.HttpServer<Deno.NetAddr>;

  constructor() {
    this.#server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      async (req) => {
        const path = new URL(req.url).pathname.replace(
          "/api/v1/serve/links",
          "",
        );
        const text = await req.text();
        if (this.down) {
          return Response.json({ error: "unavailable" }, { status: 503 });
        }
        if (this.refuseClient) {
          return Response.json({ error: this.refuseClient.error }, {
            status: this.refuseClient.status,
          });
        }
        const planRefused = this.refusePlan !== undefined &&
          (this.refusePlan.at === "capabilities"
            ? path === "/capabilities"
            : path === "" && req.method === "POST");
        if (planRefused) {
          if (path === "") this.starts++;
          return Response.json({
            error: "links_require_plan",
            ...(this.refusePlan!.message !== undefined
              ? { message: this.refusePlan!.message }
              : {}),
          }, { status: 403 });
        }
        if (path === "/capabilities") return Response.json({ version: 1 });
        if (path === "/changes" && req.method === "GET") {
          const since = new URL(req.url).searchParams.get("since");
          this.feedCursors.push(since);
          const from = since === null ? 0 : Number(since);
          return Response.json({
            ended: this.endedFeed.slice(from, from + 2),
            cursor: String(Math.min(this.endedFeed.length, from + 2)),
            more: from + 2 < this.endedFeed.length,
          });
        }
        if (path === "/people" && req.method === "POST") {
          const { linkIds } = JSON.parse(text) as { linkIds: string[] };
          return Response.json({
            people: linkIds.flatMap((id) => {
              const view = this.people.get(id);
              return view ? [{ linkId: id, ...view as object }] : [];
            }),
          });
        }
        if (path === "" && req.method === "POST") {
          this.starts++;
          return Response.json({
            requestId: `request-${this.starts}`,
            consentUrl: "http://club.test/link?code=consent-code-secret",
            digest: "digest-1",
            expiresIn: 600,
            interval: 1,
          });
        }
        if (/^\/request-\d+$/.test(path) && req.method === "GET") {
          this.statusPolls++;
          return Response.json(
            this.status === "approved"
              ? {
                status: "approved",
                digest: this.digest,
                ...(this.identity ? { identity: this.identity } : {}),
              }
              : { status: this.status },
          );
        }
        const report = path.match(/^\/request-(\d+)\/report$/);
        if (report) {
          this.reports++;
          const linkId = `link-${report[1]}`;
          this.recordedLinks.add(linkId);
          if (this.failNextReportAfterRecording) {
            this.failNextReportAfterRecording = false;
            return Response.json({ error: "unavailable" }, { status: 503 });
          }
          return Response.json({ ack: true, linkId });
        }
        if (path.endsWith("/end")) {
          this.ends.push(path);
          return Response.json({ ack: true });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.addr.port}`;
  }

  async close(): Promise<void> {
    await this.#server.shutdown();
  }
}

export interface Rig {
  repo: ServeRepo;
  club: MockClub;
  credential: string;
  directory: DelegationDirectory;
  store: DelegationStore;
  service: DelegationLinkService;
  /** moves the link service's clock past any poll wait, then runs a pass */
  pass: () => Promise<void>;
  audit: DelegationAuditRecord[];
  team: { capability: DelegationCapability };
  serveClock: { offsetMs: number; now: () => number };
  routeDeps: DelegationRouteDeps;
  integrations: Pick<IntegrationDirectory, "credentialOf" | "standingOf">;
  /** flip to revoke the integration or change its live ceiling */
  integrationState: { revoked: boolean; ceiling: Ceiling };
  post: (
    route: string,
    body: unknown,
    options?: { credential?: string },
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function withRig(
  fn: (rig: Rig) => Promise<void>,
  options: {
    requireEmailMatch?: boolean;
    admission?: TokenAdmissionChecker | null;
    ceiling?: Ceiling;
  } = {},
): Promise<void> {
  resetRateLimitState();
  await withServeRepo(async (repo) => {
    const club = new MockClub();
    const { credential, hash } = await generateIntegrationCredential(
      "slack-bot",
    );
    const record: IntegrationCredentialRecord = {
      name: "Slack bot",
      credentialHash: hash,
      requireEmailMatch: options.requireEmailMatch === true,
    };
    const integrationState = {
      revoked: false,
      ceiling: options.ceiling ?? CEILING,
    };
    const integrations = {
      credentialOf: (id: string) => id === "slack-bot" ? record : undefined,
      standingOf: (id: string): IntegrationStanding =>
        id !== "slack-bot"
          ? { kind: "unknown" }
          : integrationState.revoked
          ? { kind: "revoked" }
          : { kind: "active", ceiling: integrationState.ceiling },
    };
    const directory = new DelegationDirectory(repo.repoContext.unifiedDataRepo);
    await directory.reload();
    const store = new DelegationStore({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      lock: createRecordLock(
        repo.repoDir,
        repo.repoContext,
        repo.datastoreConfig,
        undefined,
        undefined,
      ),
      directory,
    });
    const client = new ServeLinkClient({
      baseUrl: club.url,
      clientId: "serve-client",
      clientSecret: "serve-secret",
    });
    const audit: DelegationAuditRecord[] = [];
    const team = { capability: { ok: true } as DelegationCapability };
    const serveClock = {
      offsetMs: 0,
      now: () => Date.now() + serveClock.offsetMs,
    };
    const routeDeps: DelegationRouteDeps = {
      integrations,
      directory,
      store,
      client: () => client,
      capability: () => Promise.resolve(team.capability),
      audit: (event) => audit.push(event),
      admission: options.admission ?? null,
      now: serveClock.now,
    };
    let offsetMs = 0;
    const service = new DelegationLinkService({
      now: () => Date.now() + offsetMs,
      store,
      directory,
      integrations,
      client: () => client,
      admission: { allowedCollectives: ["skunk-ape"], allowedUsers: [] },
      isLeader: () => true,
      audit: (event) => audit.push(event),
    });
    const post = async (
      route: string,
      body: unknown,
      postOptions: { credential?: string } = {},
    ) => {
      const req = new Request(`http://serve.test/api/v1/delegations/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${postOptions.credential ?? credential}`,
        },
        body: JSON.stringify(body),
      });
      const response = await handleDelegationRequest(
        req,
        matchDelegationRoute(new URL(req.url).pathname)!,
        "127.0.0.1",
        routeDeps,
      );
      return {
        status: response.status,
        body: await response.json() as Record<string, unknown>,
      };
    };
    try {
      await fn({
        repo,
        club,
        credential,
        directory,
        store,
        service,
        pass: async () => {
          offsetMs += 120_000;
          await service.tick();
        },
        audit,
        team,
        serveClock,
        routeDeps,
        integrations,
        integrationState,
        post,
      });
    } finally {
      await service.stop();
      await directory.dispose();
      await club.close();
    }
  });
}

export const START_BODY = {
  external: {
    platform: "slack",
    team_id: "T1",
    user_id: "U1",
    display: "Pat",
    workspace: "Acme",
    email: "pat@example.com",
  },
  ceiling: CEILING.toDocument(),
};

export async function startAndConsent(
  rig: Rig,
): Promise<{ pendingId: string; redeemSecret: string }> {
  const started = await rig.post("links", START_BODY);
  assertEquals(started.status, 201, JSON.stringify(started.body));
  const pendingId = started.body.pendingId as string;
  const redeemSecret = started.body.redeemSecret as string;
  rig.club.status = "approved";
  await rig.service.tick();
  return { pendingId, redeemSecret };
}
