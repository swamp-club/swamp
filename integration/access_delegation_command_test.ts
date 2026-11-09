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

import "../src/domain/models/models.ts";
import { join } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { VERSION } from "../src/cli/commands/version.ts";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import {
  issueDelegationTokens,
  recordApproval,
  recordReported,
  startDelegation,
} from "../src/domain/access/delegation.ts";
import type { DelegationRecord } from "../src/domain/models/access/delegation_model.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { createDelegationEndDeps } from "../src/libswamp/access/delegation_end.ts";
import { runCliCapturing, UNSET_ENV } from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const HASH = (c: string) => `sha256:${c.repeat(64)}`;

async function issuedRecord(nowMs: number): Promise<DelegationRecord> {
  const started = startDelegation({
    id: crypto.randomUUID(),
    integrationId: "slack-bot",
    external: {
      platform: "slack",
      teamId: "T1",
      userId: "U1",
      display: "Adam",
      workspace: "Acme",
    },
    ceiling: Ceiling.parse({ version: 1, ceiling: [] }),
    ceilingDigest: "sha256:digest",
    redeemHash: HASH("a"),
    requestId: "req-1",
    digest: "club-digest",
    consentExpiresAt: new Date(nowMs + 600_000).toISOString(),
    pollIntervalSeconds: 5,
  }, nowMs);
  const approved = recordApproval(started, {
    sub: "sub-1",
    username: "adam",
    email: "adam@example.com",
    collectives: [],
    groups: [],
  }, nowMs);
  const reported = recordReported(approved, "link-1", nowMs);
  return (await issueDelegationTokens(reported, nowMs)).record;
}

async function withRepo(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-delegation-cmd-" });
  try {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    await withMockedEnv(UNSET_ENV, () => fn(dir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function seed(dir: string, record: DelegationRecord): Promise<void> {
  const { repoContext } = await requireInitializedRepoUnlocked({
    repoDir: dir,
    outputMode: "json",
  });
  await runInRootUnitOfWork(
    repoContext,
    { flush: () => Promise.resolve(), pushWhen: "completed" },
    () => createDelegationEndDeps(repoContext).write(record),
  );
}

async function cli(args: string[]): Promise<unknown> {
  const result = await runCliCapturing({ args: [...args, "--json"] });
  if (result.error) throw result.error;
  return JSON.parse(result.stdout.join("\n"));
}

Deno.test("access delegation: list, show and end a delegation in the repo, with no hash in any reply", async () => {
  await withRepo(async (dir) => {
    const record = await issuedRecord(Date.now());
    await seed(dir, record);
    const hashes = [
      record.redeemHash,
      record.tokens!.accessHash,
      record
        .tokens!.refreshHash,
    ];

    const listed = await cli([
      "access",
      "delegation",
      "list",
      "--repo-dir",
      dir,
    ]) as Record<string, unknown>[];
    assertEquals(listed.map((v) => [v.id, v.state]), [[record.id, "issued"]]);

    const filtered = await cli([
      "access",
      "delegation",
      "list",
      "--state",
      "ended",
      "--repo-dir",
      dir,
    ]) as unknown[];
    assertEquals(filtered, []);

    const shown = await cli([
      "access",
      "delegation",
      "show",
      record.id,
      "--repo-dir",
      dir,
    ]) as Record<string, unknown>;
    assertEquals(shown.tokenGeneration, 1);

    const ended = await cli([
      "access",
      "delegation",
      "end",
      record.id,
      "--repo-dir",
      dir,
    ]) as Record<string, unknown>;
    assertEquals(ended.state, "ended");
    assertEquals(ended.endCause, "operator");
    assertEquals(ended.alreadyEnded, false);
    assertEquals((ended.club as { endState: string }).endState, "pending");
    assertEquals(ended.tokenGeneration, undefined);

    const again = await cli([
      "access",
      "delegation",
      "end",
      record.id,
      "--repo-dir",
      dir,
    ]) as Record<string, unknown>;
    assertEquals(again.alreadyEnded, true);
    assertEquals(again.state, "ended");

    for (const reply of [listed, shown, ended, again]) {
      const text = JSON.stringify(reply);
      for (const hash of hashes) assert(!text.includes(hash), text);
    }
  });
});

Deno.test("access delegation: end refuses an id that is not a delegation", async () => {
  await withRepo(async (dir) => {
    const result = await runCliCapturing({
      args: [
        "access",
        "delegation",
        "end",
        crypto.randomUUID(),
        "--repo-dir",
        dir,
        "--json",
      ],
    });
    assert(result.error instanceof Error);
    assertStringIncludes(result.error.message, "Delegation");
    assertStringIncludes(result.error.message, "does not exist");
  });
});

function fakeServe(reply: (type: string, payload: unknown) => unknown) {
  const sent: { type: string; payload: unknown }[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          id: string;
          type: string;
          payload: unknown;
        };
        sent.push({ type: request.type, payload: request.payload });
        socket.send(JSON.stringify({
          type: request.type,
          id: request.id,
          payload: { data: reply(request.type, request.payload) },
        }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    sent,
    [Symbol.asyncDispose]: () => server.shutdown(),
  };
}

const VIEW = {
  id: "6f1c2a52-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  integrationId: "slack-bot",
  state: "ended",
  external: {
    platform: "slack",
    teamId: "T1",
    userId: "U1",
    display: "Adam",
    workspace: "Acme",
  },
  ceilingDigest: "sha256:digest",
  createdAt: new Date(0).toISOString(),
  club: { endState: "pending", endAttempts: 0 },
};

Deno.test("access delegation: --server sends the filter on list and an end request, and renders the reply", async () => {
  await withMockedEnv(UNSET_ENV, async () => {
    await using serve = fakeServe((type) =>
      type === "access.delegation.list"
        ? { delegations: [VIEW], count: 1 }
        : { delegation: VIEW, alreadyEnded: false }
    );
    const listed = await cli([
      "access",
      "delegation",
      "list",
      "--integration",
      "slack-bot",
      "--server",
      serve.url,
    ]) as unknown[];
    assertEquals(listed, [VIEW]);
    const ended = await cli([
      "access",
      "delegation",
      "end",
      VIEW.id,
      "--server",
      serve.url,
    ]);
    assertEquals(ended, { ...VIEW, alreadyEnded: false });
    assertEquals(serve.sent, [
      {
        type: "access.delegation.list",
        payload: { integrationId: "slack-bot" },
      },
      { type: "access.delegation.end", payload: { id: VIEW.id } },
    ]);
  });
});
