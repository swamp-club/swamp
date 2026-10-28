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

/**
 * How a v3 checkout written through serve (swamp-club#3985) meets serve
 * failing it: unreachable, refusing its token, answering a conflict, lost
 * after it landed a commit, or feeding it a hostile record key. Opened the
 * production way, against a real serve in a Worker, with a proxy in front
 * where serve itself would never answer so.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { V3_SERVE_UNREACHABLE_CODE } from "../src/infrastructure/datastore_v3/serve_upstream_errors.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { v3DatastoreFor } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  SERVE_COPY_HOLDS_UNLANDED_CODE,
  ServeCopyHoldsUnlandedCommitsError,
} from "../src/infrastructure/datastore_v3/checkout_view.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import { PreconditionConflictError } from "../src/infrastructure/datastore_v3/forwarded_commit.ts";
import {
  setV3DatastoreFaultsForTesting,
  v3OutboxPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import { datastoreErrorResponse } from "../src/serve/datastore_api.ts";
import { captureLogs } from "./remote_secrets_baseline_harness.ts";
import {
  SERVE_UPSTREAM_STATE_FILE,
  ServeUpstreamState,
} from "../src/infrastructure/datastore_v3/serve_upstream_state.ts";
import {
  type Client,
  dataOf,
  json,
  latestOf,
  MEMBER,
  readCommand,
  serveEnv,
  startProxy,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

/** The follower copy's `commits.db` and outbox of `client` under serve at `origin`. */
function copyFiles(
  client: Client,
  origin: string,
): {
  commitsDb: string;
  outbox: string;
} {
  const root = serveUpstreamLocalRoot(client.repoDir, origin, "");
  const commitsDb = join(root, "commits.db");
  return { commitsDb, outbox: v3OutboxPath(commitsDb) };
}

/** The commits (by partition, seq and txnId) and outbox entries of `client`'s copy. */
async function copyContent(
  client: Client,
  origin: string,
): Promise<{ commits: string[]; outbox: string[] }> {
  const store = SqliteCommitStore.open(copyFiles(client, origin).commitsDb, {
    follower: true,
  });
  try {
    const changes = await store.changesSince(0, 100_000);
    return {
      commits: changes.map(({ commit }) =>
        `${commit.partition}@${commit.seq}:${commit.txnId}`
      ),
      outbox: await outboxEntries(client, origin),
    };
  } finally {
    await store.close();
  }
}

/** The outbox entries of `client`'s follower copy, by txnId. */
async function outboxEntries(
  client: Client,
  origin: string,
): Promise<string[]> {
  const outbox = new SqliteCommitOutbox(copyFiles(client, origin).outbox);
  try {
    const listing = await outbox.entries();
    assertEquals(listing.unreadable, []);
    return listing.entries.map((entry) => entry.commit.txnId);
  } finally {
    await outbox.close();
  }
}

Deno.test({
  name:
    "serve upstream errors: with serve unreachable a read goes on from the local copy with a warning, and a write is refused with exit 75, changing nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const client = await scratch.client("a", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;
      await writeCommand(
        scratch,
        client,
        env,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
      );
      await serve.stop();

      // The read: from the copy, saying it may be out of date.
      let read: unknown;
      const logs = await captureLogs(async () => {
        read = await readCommand(
          scratch,
          client,
          env,
          async (repos) => {
            // A second catch-up in the same command, as a longer command
            // makes: still one warning.
            await v3DatastoreFor(client.repoDir, {
              path: serveUpstreamLocalRoot(client.repoDir, serve.origin, ""),
            }).catchUp();
            return await latestOf(repos, type, web, "vpc");
          },
        );
      });
      assertEquals(read, { version: 1, content: "1" });
      assert(
        logs.some((log) =>
          log.level === "warning" &&
          log.text.includes(`Could not reach serve at ${serve.origin}`)
        ),
        `no warning that serve was unreachable: ${JSON.stringify(logs)}`,
      );
      assertEquals(
        logs.filter((log) =>
          log.level === "warning" &&
          log.text.includes(`Could not reach serve at ${serve.origin}`)
        ).length,
        1,
        `the warning repeats within one command: ${JSON.stringify(logs)}`,
      );
      // The cause's message, never the error object, which the CLI's sink
      // renders with its whole stack.
      assert(
        !logs.some((log) =>
          log.text.includes("Could not reach serve") &&
          /\b\w*Error: /.test(log.text)
        ),
        `the warning interpolates the error object: ${JSON.stringify(logs)}`,
      );

      // The write: refused before anything changed.
      // Its local lease raises the copy's writer fence, so the files are
      // compared by what they hold: commits and outbox entries.
      const before = await copyContent(client, serve.origin);
      assert(before.commits.length > 0, "the copy holds no commits");
      // Refused as the write context opens, before the command's action
      // runs: a method run's side effects must not happen when its result
      // could not be committed.
      let actionRan = false;
      const error = await assertRejects(() =>
        writeCommand(
          scratch,
          client,
          env,
          (repos) => {
            actionRan = true;
            return repos.unifiedDataRepo.save(
              type,
              web,
              dataOf("vpc"),
              json(2),
            );
          },
        )
      );
      assertEquals(
        (error as { code?: string }).code,
        V3_SERVE_UNREACHABLE_CODE,
        String(error),
      );
      assertEquals(
        actionRan,
        false,
        "the command's action ran before the refusal",
      );
      assertEquals(exitCodeForError(error), 75);
      assertEquals(
        await copyContent(client, serve.origin),
        before,
        "the refused write changed the follower copy or its outbox",
      );
      assertEquals(await outboxEntries(client, serve.origin), []);
      assertEquals(bucket.touched(), []);
      assertEquals(
        await readCommand(
          scratch,
          client,
          env,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        { version: 1, content: "1" },
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream errors: a token serve refuses fails the command as unauthorized with the server-login hint",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const client = await scratch.client("a", { bucket });
      const error = await assertRejects(() =>
        writeCommand(
          scratch,
          client,
          serveEnv(serve, "expired-token"),
          (repos) =>
            repos.unifiedDataRepo.save(
              serve.modelType,
              serve.models.web,
              dataOf("vpc"),
              json(1),
            ),
        )
      );
      assertEquals((error as { code?: string }).code, "unauthorized");
      assert(
        error instanceof Error &&
          error.message.includes("swamp auth server-login"),
        String(error),
      );
      assertEquals(
        (await serve.log()).filter((entry) => entry.principal !== undefined),
        [],
      );
      assertEquals(bucket.touched(), []);
    });
  },
});

Deno.test({
  name:
    "serve upstream errors: a token file is never sent to a serve only the repository marker names",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const tokenFile = join(scratch.dir, "token");
      await Deno.writeTextFile(tokenFile, "alice-token\n");
      const proxy = startProxy(serve.origin);
      try {
        const client = await scratch.client("a", {
          bucket,
          serverAddress: proxy.origin,
        });
        const save = (env: Record<string, string | undefined>) =>
          writeCommand(
            scratch,
            client,
            env,
            (repos) =>
              repos.unifiedDataRepo.save(
                serve.modelType,
                serve.models.web,
                dataOf("vpc"),
                json(1),
              ),
          );

        // The marker alone names the proxy: the token file is not bound to
        // it, so nothing carries a token and serve refuses.
        const error = await assertRejects(() =>
          save({ SWAMP_SERVER_TOKEN_FILE: tokenFile })
        );
        assertEquals((error as { code?: string }).code, "unauthorized");
        assert(proxy.requests.length > 0, "no request reached the proxy");
        assertEquals(
          proxy.requests.filter((request) => request.authorization !== null),
          [],
          "a request carried the token file's token to a marker-only address",
        );

        // Named by SWAMP_SERVE_URL too, the same file is bound, and sent.
        proxy.requests.length = 0;
        await save({
          SWAMP_SERVE_URL: proxy.origin,
          SWAMP_SERVER_TOKEN_FILE: tokenFile,
        });
        assert(proxy.requests.length > 0);
        assert(
          proxy.requests.every((request) =>
            request.authorization === "Bearer alice-token"
          ),
          JSON.stringify(proxy.requests),
        );
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "serve upstream errors: serve's precondition conflict reaches the caller naming who changed the record and when",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const type = serve.modelType;
      const web = serve.models.web;
      const key = `data/${type.normalized}/${web}/vpc/1/metadata.yaml`;
      // A real serve answers stale_seq first whenever the client's copy
      // could have seen the change, so its precondition refusal is
      // answered here as serve's own reply builder words it.
      const proxy = startProxy(serve.origin, (request) =>
        Promise.resolve(
          request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/commits")
            ? datastoreErrorResponse(
              new PreconditionConflictError(
                key,
                1,
                "user:bob",
                "2026-10-27T01:02:03.000Z",
              ),
            )
            : undefined,
        ));
      try {
        const client = await scratch.client("a", { bucket });
        const error = await assertRejects(() =>
          writeCommand(
            scratch,
            client,
            serveEnv(proxy, "alice-token"),
            (repos) =>
              repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
          )
        );
        assert(
          error instanceof Error &&
            error.message.includes(
              `${key} was changed by user:bob at 2026-10-27T01:02:03.000Z`,
            ),
          String(error),
        );
        // Refused as a local commit whose expect failed is.
        assertEquals((error as { reason?: unknown }).reason, "expect-failed");
        assertEquals(await outboxEntries(client, proxy.origin), []);
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "serve upstream errors: a commit serve landed before the client was cut off is settled by the next command, never sent twice",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const client = await scratch.client("a", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;

      // Serve lands the commit; the client is cut off before it learns so,
      // and can neither ask serve nor give its outbox entry up: as a
      // process killed there leaves it.
      let cut = false;
      const gone = () => Promise.reject(new Error("cut off"));
      setV3DatastoreFaultsForTesting({
        wrapSink: (sink) => ({
          ...sink,
          append: async (commit) => {
            await sink.append(commit);
            cut = true;
            throw new Error("cut off after serve landed the commit");
          },
          ...(sink.outbox !== undefined
            ? {
              outbox: {
                ...sink.outbox,
                landedSeq: gone,
                discard: gone,
                abandon: gone,
              },
            }
            : {}),
        }),
      });
      try {
        await assertRejects(() =>
          writeCommand(
            scratch,
            client,
            env,
            (repos) =>
              repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
          )
        );
      } finally {
        setV3DatastoreFaultsForTesting(undefined);
      }
      assert(cut, "the commit never reached serve");
      const landed = (await serve.log()).filter((entry) =>
        entry.principal === "user:caller"
      );
      assertEquals(landed.length, 1);
      assertEquals(
        await outboxEntries(client, serve.origin),
        [landed[0].txnId],
        "the cut left no outbox entry to recover",
      );

      // The next writing command settles it from serve.
      await writeCommand(
        scratch,
        client,
        env,
        (repos) => repos.unifiedDataRepo.save(type, web, dataOf("db"), json(2)),
      );
      assertEquals(await outboxEntries(client, serve.origin), []);
      const after = (await serve.log()).filter((entry) =>
        entry.principal === "user:caller"
      );
      assertEquals(
        after.filter((entry) => entry.txnId === landed[0].txnId).length,
        1,
        "the recovered commit landed twice",
      );
      assertEquals(after.length, 2);
      assertEquals(
        await readCommand(scratch, client, env, async (repos) => [
          await latestOf(repos, type, web, "vpc"),
          await latestOf(repos, type, web, "db"),
        ]),
        [{ version: 1, content: "1" }, { version: 1, content: "2" }],
      );
    });
  },
});

/**
 * Runs `write` as a command in `client` whose commit lands at serve while
 * its outbox entry is never settled, as a process killed there leaves it.
 */
async function leaveUnsettledWrite(
  scratch: Parameters<typeof writeCommand>[0],
  client: Client,
  env: Record<string, string | undefined>,
  write: Parameters<typeof writeCommand>[3],
): Promise<void> {
  const gone = () => Promise.reject(new Error("cut off"));
  setV3DatastoreFaultsForTesting({
    wrapSink: (sink) => ({
      ...sink,
      append: async (commit) => {
        await sink.append(commit);
        throw new Error("cut off after serve landed the commit");
      },
      ...(sink.outbox !== undefined
        ? {
          outbox: {
            ...sink.outbox,
            landedSeq: gone,
            discard: gone,
            abandon: gone,
          },
        }
        : {}),
    }),
  });
  try {
    await assertRejects(() => writeCommand(scratch, client, env, write));
  } finally {
    setV3DatastoreFaultsForTesting(undefined);
  }
}

Deno.test({
  name:
    "serve upstream errors: a token switch is refused while the copy holds the previous token's unlanded writes, and goes through once they settle",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const client = await scratch.client("a", { bucket });
      const aliceEnv = serveEnv(serve, "alice-token");
      const bobEnv = serveEnv(serve, "bob-token");
      const type = serve.modelType;
      const web = serve.models.web;

      // Alice's write lands at serve, but her outbox entry is never
      // settled, as a process killed there leaves it.
      await leaveUnsettledWrite(
        scratch,
        client,
        aliceEnv,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
      );
      const before = await copyContent(client, serve.origin);
      assertEquals(before.outbox.length, 1);

      // Bob's token in the same checkout would reset the copy and drop
      // Alice's entry: refused, and nothing changed.
      const refused = await assertRejects(
        () => readCommand(scratch, client, bobEnv, () => Promise.resolve()),
        ServeCopyHoldsUnlandedCommitsError,
      );
      assertEquals(refused.code, SERVE_COPY_HOLDS_UNLANDED_CODE);
      assertEquals(exitCodeForError(refused), 1);
      assertEquals(await copyContent(client, serve.origin), before);

      // Alice's next command settles it; then Bob's goes through and reads
      // none of Alice's records.
      assertEquals(
        await writeCommand(
          scratch,
          client,
          aliceEnv,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        { version: 1, content: "1" },
      );
      assertEquals(await outboxEntries(client, serve.origin), []);
      assertEquals(
        await readCommand(
          scratch,
          client,
          bobEnv,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        null,
      );
      assertEquals(bucket.touched(), []);
    });
  },
});

Deno.test({
  name:
    "serve upstream errors: a move to another serve is refused while the first serve's copy holds unlanded writes, and goes through once they settle",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serveA = await scratch.serve();
      const serveB = await scratch.serve();
      const bucket = scratch.bucket();
      const client = await scratch.client("a", { bucket });
      const envA = serveEnv(serveA, "alice-token");
      const envB = serveEnv(serveB, "alice-token");
      const type = serveA.modelType;
      const web = serveA.models.web;

      await leaveUnsettledWrite(
        scratch,
        client,
        envA,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
      );
      const before = await copyContent(client, serveA.origin);
      assertEquals(before.outbox.length, 1);

      // Moving to serve B would rebuild the checkout from B and leave A's
      // entry behind: refused, naming A, and A's copy is unchanged.
      const refused = await assertRejects(
        () => readCommand(scratch, client, envB, () => Promise.resolve()),
        ServeCopyHoldsUnlandedCommitsError,
      );
      assertEquals(refused.code, SERVE_COPY_HOLDS_UNLANDED_CODE);
      assertEquals(refused.serveUrl, serveA.origin);
      assertEquals(await copyContent(client, serveA.origin), before);

      // A writing command on A settles it; then the move goes through.
      assertEquals(
        await writeCommand(
          scratch,
          client,
          envA,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        { version: 1, content: "1" },
      );
      assertEquals(await outboxEntries(client, serveA.origin), []);
      assertEquals(
        await readCommand(
          scratch,
          client,
          envB,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        null,
      );
      assertEquals(bucket.touched(), []);
    });
  },
});

for (
  const [label, hostile] of [
    ["a relative key escaping the checkout", "../../evil"],
    ["an absolute key", "<abs>"],
  ] as const
) {
  Deno.test({
    name:
      `serve upstream errors: ${label} in a commit serve feeds is refused, and nothing is written outside the checkout`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withScratch(async (scratch) => {
        const serve = await scratch.serve();
        const bucket = scratch.bucket();
        const type = serve.modelType;
        const web = serve.models.web;
        const writer = await scratch.client("writer", { bucket });
        await writeCommand(
          scratch,
          writer,
          serveEnv(serve, "alice-token"),
          (repos) =>
            repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
        );
        const evil = hostile === "<abs>"
          ? join(scratch.dir, "abs-evil")
          : hostile;
        const real = `data/${type.normalized}/${web}/vpc/1/raw`;
        // Every reply that names the record names the hostile key instead,
        // escaped as a JSON string so a Windows path's `\` stays valid JSON.
        const evilInJson = JSON.stringify(evil).slice(1, -1);
        const proxy = startProxy(serve.origin, async (request, forward) => {
          if (request.method !== "GET") return undefined;
          const response = await forward();
          const text = await response.text();
          return new Response(text.replaceAll(real, evilInJson), {
            status: response.status,
            headers: response.headers,
          });
        });
        try {
          const victim = await scratch.client("victim", { bucket });
          const outcome = await readCommand(
            scratch,
            victim,
            serveEnv(proxy, "alice-token"),
            (repos) => latestOf(repos, type, web, "vpc"),
          ).then(
            (value) => ({ read: value }),
            (error) => ({ refused: String(error) }),
          );
          assert(
            "refused" in outcome && outcome.refused.includes("Record key"),
            `the hostile commit was not refused by the record key guard: ${
              JSON.stringify(outcome)
            }`,
          );
          for (
            const path of [
              join(scratch.dir, "evil"),
              join(victim.repoDir, "evil"),
              join(scratch.dir, "abs-evil"),
            ]
          ) {
            assert(!(await exists(path)), `${path} was written`);
          }
        } finally {
          await proxy.close();
        }
      });
    },
  });
}

Deno.test({
  name:
    "serve upstream errors: a checkout that never read serve refuses a read while serve is unreachable, rather than showing an empty datastore",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const writer = await scratch.client("w", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;
      await writeCommand(
        scratch,
        writer,
        env,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
      );
      const fresh = await scratch.client("fresh", { bucket });
      await serve.stop();
      const error = await assertRejects(() =>
        readCommand(
          scratch,
          fresh,
          env,
          (repos) => latestOf(repos, type, web, "vpc"),
        )
      );
      assertEquals(
        (error as { code?: string }).code,
        V3_SERVE_UNREACHABLE_CODE,
        String(error),
      );
      assertEquals(exitCodeForError(error), 75);
      assert(
        String(error).includes("has not read this datastore from serve yet"),
        String(error),
      );
    });
  },
});

/** The id of the copy `client` holds of serve at `origin`. */
function copyIdOf(client: Client, origin: string): string {
  const state = ServeUpstreamState.open(
    join(
      serveUpstreamLocalRoot(client.repoDir, origin, ""),
      SERVE_UPSTREAM_STATE_FILE,
    ),
  );
  try {
    return state.copyId();
  } finally {
    state.close();
  }
}

Deno.test({
  name:
    "serve upstream errors: a change of access waits while the copy holds unlanded writes, warning, and rebuilds the copy once a writing command lands them (swamp-club#4089)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const client = await scratch.client("a", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;

      await leaveUnsettledWrite(
        scratch,
        client,
        env,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
      );
      const id = copyIdOf(client, serve.origin);
      assertEquals((await outboxEntries(client, serve.origin)).length, 1);

      // Alice's access widens; the next command sees it.
      await serve.setGrants([
        ...MEMBER,
        { actions: ["read"], kind: "workflow", pattern: "*" },
      ]);
      await readCommand(scratch, client, env, () => Promise.resolve());

      // A rebuild now would drop the unlanded entry: the command goes on
      // with the copy as it is, and says why.
      const deferred = await captureLogs(async () => {
        assertEquals(
          await readCommand(
            scratch,
            client,
            env,
            (repos) => latestOf(repos, type, web, "vpc"),
          ),
          { version: 1, content: "1" },
        );
      });
      assert(
        deferred.some((log) =>
          log.level === "warning" &&
          log.text.includes("still holds writes that have not finished")
        ),
        JSON.stringify(deferred),
      );
      assertEquals(copyIdOf(client, serve.origin), id);
      assertEquals((await outboxEntries(client, serve.origin)).length, 1);

      // A writing command lands it; the next command rebuilds the copy.
      await writeCommand(
        scratch,
        client,
        env,
        (repos) => latestOf(repos, type, web, "vpc"),
      );
      assertEquals(await outboxEntries(client, serve.origin), []);
      assertEquals(
        await readCommand(
          scratch,
          client,
          env,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        { version: 1, content: "1" },
      );
      assert(copyIdOf(client, serve.origin) !== id, "the copy was rebuilt");
      assertEquals(
        (await serve.log()).filter((entry) =>
          entry.keys.some((key) => key.includes("vpc"))
        ).length,
        1,
        "the unlanded write landed once",
      );
      assertEquals(bucket.touched(), []);
    });
  },
});
