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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { partitionLockKey } from "../src/infrastructure/datastore_v3/partition_locks.ts";
import { forwardedCommitGateOf } from "../src/serve/forwarded_commit_gate.ts";
import { setCommitStageBarrierForTesting } from "../src/serve/datastore_api.ts";
import { stringify as stringifyYaml } from "@std/yaml";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  createDefinitionId,
  Definition,
} from "../src/domain/definitions/definition.ts";
import { grant } from "./serve_request_harness.ts";
import {
  blobSaveOps,
  call,
  commitBody,
  modelKey,
  partitionPath,
  post,
  type Server,
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

async function dataCommit(
  server: Server,
  modelId: string,
  expectedSeq: number,
  name = "vpc",
): Promise<Uint8Array> {
  const content = new TextEncoder().encode(crypto.randomUUID());
  return commitBody({
    expectedSeq,
    txnId: crypto.randomUUID(),
    ops: await blobSaveOps(server, name, expectedSeq + 1, content, modelId),
    chunks: [{ sha256: await sha256Hex(content), size: content.length }],
  }, [content]);
}

function modelPartition(server: Server, id: string) {
  return partitionOf({ kind: "model", type: server.modelType, id });
}

Deno.test({
  name:
    "forwarded commits: a commit to one behavior lands while another behavior's commit waits on its held partition",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const other = createDefinitionId(crypto.randomUUID());
      const held = partitionLockKey(
        server.v3.namespace,
        modelPartition(server, server.model.id),
      );
      const gate = forwardedCommitGateOf(server.v3);
      let first: Promise<{ status: number }> | undefined;
      let firstSettled = false;
      // held as serve's own unit of work holds a partition it appends to
      await server.v3.holdPartitions([held], async () => {
        first = post(
          partitionPath(server),
          "alice-token",
          await dataCommit(server, server.model.id, 0),
        ).then((response) => {
          firstSettled = true;
          return response;
        });
        // inside its section, waiting on the held partition
        await waitFor(() => gate.state.shared === 1, "the first section");
        const second = await post(
          partitionPath(server, other),
          "alice-token",
          await dataCommit(server, other, 0),
        );
        assertEquals(second.status, 200, JSON.stringify(second));
        assertEquals(firstSettled, false);
      });
      const landed = await first!;
      assertEquals(landed.status, 200);
      assertEquals(gate.state, { shared: 0, exclusive: false, waiting: 0 });
    });
  },
});

Deno.test({
  name:
    "forwarded commits: a revoke applies to a commit whose section starts after it lands, though serve has not caught up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // the caller may write any behavior not tagged env=prod
    const notProd = [
      grant({
        actions: ["read", "write", "run"],
        resource: { kind: "model", pattern: "*" },
        condition: '!("env" in tags) || tags.env != "prod"',
      }),
      grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
    ];
    await withServer(
      notProd,
      async (server) => {
        const before = await post(
          partitionPath(server),
          "alice-token",
          await dataCommit(server, server.model.id, 0),
        );
        assertEquals(before.status, 200, JSON.stringify(before));
        const retagged = Definition.fromData({
          ...server.model.toData(),
          tags: { env: "prod" },
        });
        const held = partitionLockKey(
          server.v3.namespace,
          modelPartition(server, server.model.id),
        );
        const gate = forwardedCommitGateOf(server.v3);
        let after: Promise<{ status: number }> | undefined;
        await server.v3.holdPartitions([held], async () => {
          // judged outside the lock before the retag, then waits in its
          // section for the held partition
          after = post(
            partitionPath(server),
            "alice-token",
            await dataCommit(server, server.model.id, 1),
          );
          await waitFor(() => gate.state.shared === 1, "the commit's section");
          // serve's own retag lands before the section judges, and serve's
          // read model has not applied it
          await runInRootUnitOfWork(
            server.ctx.repoContext,
            { flush: undefined },
            () =>
              server.ctx.repoContext.definitionRepo.save(
                server.modelType,
                retagged,
              ),
          );
          assert(
            server.v3.readModel.cursor() <
              server.v3.commitStore.authorityCursor(),
            "serve's read model has not applied the retag yet",
          );
        });
        const refused = await after!;
        assertEquals(refused.status, 403, JSON.stringify(refused));
      },
      undefined,
      { managedConfig: true },
    );
  },
});

Deno.test({
  name: "forwarded commits: a lock renewal does not wait on a catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: modelKey(server),
      });
      assertEquals(taken.status, 201, JSON.stringify(taken.json));
      const catchUp = server.v3.catchUp.bind(server.v3);
      let catchUps = 0;
      server.v3.catchUp = (...args) => {
        catchUps++;
        return catchUp(...args);
      };
      try {
        const renewed = await call(
          server,
          "PUT",
          `locks/${taken.json.leaseId}`,
          "alice-token",
          {},
        );
        assertEquals(renewed.status, 200, JSON.stringify(renewed.json));
        assertEquals(catchUps, 0);
      } finally {
        server.v3.catchUp = catchUp;
      }
      await call(
        server,
        "DELETE",
        `locks/${taken.json.leaseId}`,
        "alice-token",
      );
    });
  },
});

Deno.test({
  name:
    "forwarded commits: a deposed leader's commit is refused while another partition's section is in flight, and neither lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const other = createDefinitionId(crypto.randomUUID());
      const held = partitionLockKey(
        server.v3.namespace,
        modelPartition(server, server.model.id),
      );
      const gate = forwardedCommitGateOf(server.v3);
      let first: Promise<{ status: number }> | undefined;
      await server.v3.holdPartitions([held], async () => {
        first = post(
          partitionPath(server),
          "alice-token",
          await dataCommit(server, server.model.id, 0),
        );
        await waitFor(() => gate.state.shared === 1, "the first section");
        // a new leader took over the store this serve writes
        await server.v3.commitStore.raiseWriterFence(
          (server.v3.commitStore.writerFence() ?? 0) + 1,
        );
        const second = await post(
          partitionPath(server, other),
          "alice-token",
          await dataCommit(server, other, 0),
        );
        assert(second.status >= 400, JSON.stringify(second));
      });
      const refused = await first!;
      assert(refused.status >= 400, JSON.stringify(refused));
      for (const id of [server.model.id, other]) {
        const head = await server.v3.commitStore.head(
          server.v3.namespace,
          modelPartition(server, id),
        );
        assertEquals(head.seq, 0, id);
      }
    });
  },
});

function latch(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => open = resolve);
  return { open, opened };
}

Deno.test({
  name:
    "forwarded commits: a commit judged before a forwarded revoke and admitted after it catches up before it judges again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants = [
      grant({
        actions: ["read", "write", "run"],
        resource: { kind: "model", pattern: "*" },
        condition: '!("env" in tags) || tags.env != "prod"',
      }),
      grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["read", "write", "run", "tag"],
        resource: { kind: "model", pattern: "*" },
      }),
    ];
    await withServer(
      grants,
      async (server) => {
        const first = await post(
          partitionPath(server),
          "alice-token",
          await dataCommit(server, server.model.id, 0),
        );
        assertEquals(first.status, 200, JSON.stringify(first));
        const config = partitionOf({
          kind: "config",
          definitionKind: "model",
          name: "web",
        });
        const data = JSON.parse(JSON.stringify(server.model.toData()));
        data.type = server.modelType.normalized;
        data.tags = { env: "prod" };
        const retag = {
          kind: "put",
          intent: {
            kind: "definition.edit",
            definition: { kind: "model", name: "web" },
          },
          key: `config/models/${server.modelType.normalized}/web.yaml`,
          inline: btoa(
            stringifyYaml(
              JSON.parse(JSON.stringify(Definition.fromData(data).toData())),
            ),
          ),
        };
        const configHead = await server.v3.commitStore.head(
          server.v3.namespace,
          config,
        );

        // While skipping, a catch-up applies nothing: the revoke's own
        // catch-up after it lands leaves serve behind.
        let skipping = false;
        const catchUp = server.v3.catchUp.bind(server.v3);
        server.v3.catchUp = (...args) =>
          skipping ? Promise.resolve() : catchUp(...args);
        const revokeAtAppend = latch();
        const releaseRevoke = latch();
        const commitAtCatchUp = latch();
        const releaseCommit = latch();
        let revokeSeen = false;
        let commitArmed = false;
        setCommitStageBarrierForTesting(async (stage) => {
          if (stage === "append" && !revokeSeen) {
            revokeSeen = true;
            skipping = true;
            revokeAtAppend.open();
            await releaseRevoke.opened;
          } else if (stage === "locked_catch_up" && commitArmed) {
            commitArmed = false;
            commitAtCatchUp.open();
            await releaseCommit.opened;
          }
        });
        try {
          const revoke = post(
            `${server.url}/partitions/${
              encodeURIComponent(config.toString())
            }/commits`,
            "bob-token",
            commitBody({
              expectedSeq: configHead.seq,
              txnId: crypto.randomUUID(),
              ops: [retag],
              chunks: [],
            }),
          );
          await revokeAtAppend.opened;
          commitArmed = true;
          // judged now, before the revoke lands; then waits at the gate
          const commit = post(
            partitionPath(server),
            "alice-token",
            await dataCommit(server, server.model.id, 1),
          );
          const gate = forwardedCommitGateOf(server.v3);
          await waitFor(
            () => gate.state.waiting === 1,
            "the commit at the gate",
          );
          releaseRevoke.open();
          const revoked = await revoke;
          assertEquals(revoked.status, 200, JSON.stringify(revoked));
          await commitAtCatchUp.opened;
          assert(
            server.v3.readModel.cursor() <
              server.v3.commitStore.authorityCursor(),
            "serve has not applied the revoke when the commit's section starts",
          );
          skipping = false;
          releaseCommit.open();
          const refused = await commit;
          assertEquals(refused.status, 403, JSON.stringify(refused));
        } finally {
          setCommitStageBarrierForTesting(undefined);
          server.v3.catchUp = catchUp;
        }
      },
      undefined,
      { managedConfig: true },
    );
  },
});
