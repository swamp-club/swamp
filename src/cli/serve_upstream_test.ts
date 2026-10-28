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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  resolveServeUpstream,
  serveUpstreamAppliesTo,
  serveUpstreamRunsLocally,
} from "./serve_upstream.ts";
import { resetMarkerServerAddress } from "./remote_run.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import { UserError } from "../domain/errors.ts";

const UNSET_ENV: Record<string, string | undefined> = {
  SWAMP_SERVE_URL: undefined,
  SWAMP_SERVER_URL: undefined,
  SWAMP_SERVER_TOKEN: undefined,
  SWAMP_SERVER_TOKEN_FILE: undefined,
  SWAMP_SERVE_EXTRA_HEADERS: undefined,
};

const noCaCerts = () => undefined;

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-upstream-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((e) => {
      if (Deno.build.os !== "windows") throw e;
    });
  }
}

/** A servers.json in `dir` holding `token` for `serverUrl`. */
async function storedCredential(
  dir: string,
  serverUrl: string,
  token: string,
): Promise<FileServerCredentialRepository> {
  const repo = new FileServerCredentialRepository({ configDir: dir });
  await repo.save({
    serverUrl,
    tokenName: "alice",
    token,
    principalId: "p-1",
    obtainedAt: "2026-10-27T00:00:00Z",
  });
  return repo;
}

async function writeTokenFile(dir: string, token: string): Promise<string> {
  const path = join(dir, "token");
  await Deno.writeTextFile(path, `${token}\n`);
  return path;
}

Deno.test("resolveServeUpstream: no serve address gives no upstream", async () => {
  resetMarkerServerAddress();
  await withMockedEnv(UNSET_ENV, async () => {
    const target = await resolveServeUpstream({
      engine: "v3",
      commandPath: ["data", "get"],
      getCaCerts: noCaCerts,
    });
    assertEquals(target, undefined);
  });
});

Deno.test("resolveServeUpstream: a v2 datastore never uses serve as upstream", async () => {
  await withMockedEnv(
    { ...UNSET_ENV, SWAMP_SERVE_URL: "http://serve.test:9090" },
    async () => {
      const target = await resolveServeUpstream({
        engine: "v2",
        commandPath: ["data", "get"],
        getCaCerts: noCaCerts,
      });
      assertEquals(target, undefined);
    },
  );
});

Deno.test("resolveServeUpstream: an excluded command never uses serve as upstream", async () => {
  await withMockedEnv(
    { ...UNSET_ENV, SWAMP_SERVE_URL: "http://serve.test:9090" },
    async () => {
      for (
        const path of [["serve"], ["worker", "connect"], ["datastore", "setup"]]
      ) {
        const target = await resolveServeUpstream({
          engine: "v3",
          commandPath: path,
          getCaCerts: noCaCerts,
        });
        assertEquals(target, undefined, path.join(" "));
      }
    },
  );
});

Deno.test("resolveServeUpstream: env address takes the stored servers.json credential", async () => {
  await withTemp(async (dir) => {
    const repo = await storedCredential(
      dir,
      "https://serve.test:9443",
      "alice.secret",
    );
    await withMockedEnv(
      { ...UNSET_ENV, SWAMP_SERVE_URL: "wss://SERVE.test:9443/" },
      async () => {
        const target = await resolveServeUpstream({
          engine: "v3",
          commandPath: ["model", "method"],
          credentialRepository: repo,
          getCaCerts: () => ["-----BEGIN CERTIFICATE-----\nx\n"],
        });
        assert(target !== undefined);
        assertEquals(target.serverUrl, "https://serve.test:9443");
        assertEquals(target.token, "alice.secret");
        assertEquals(target.caCerts, ["-----BEGIN CERTIFICATE-----\nx\n"]);
        assertEquals(target.extraHeaders, {});
      },
    );
  });
});

Deno.test("resolveServeUpstream: marker address takes the stored credential and extra headers", async () => {
  await withTemp(async (dir) => {
    const repo = await storedCredential(
      dir,
      "http://serve.test:9090",
      "alice.secret",
    );
    await withMockedEnv(
      { ...UNSET_ENV, SWAMP_SERVE_EXTRA_HEADERS: "X-Tunnel: abc" },
      async () => {
        const target = await resolveServeUpstream({
          engine: "v3",
          commandPath: ["data", "get"],
          markerServerAddress: "ws://serve.test:9090",
          credentialRepository: repo,
          getCaCerts: noCaCerts,
        });
        assert(target !== undefined);
        assertEquals(target.token, "alice.secret");
        assertEquals(target.extraHeaders, { "X-Tunnel": "abc" });
        assertEquals(target.caCerts, undefined);
      },
    );
  });
});

Deno.test("resolveServeUpstream: a marker-only address never reads SWAMP_SERVER_TOKEN_FILE", async () => {
  await withTemp(async (dir) => {
    const tokenFile = await writeTokenFile(dir, "leaked.secret");
    const repo = new FileServerCredentialRepository({ configDir: dir });
    await withMockedEnv(
      { ...UNSET_ENV, SWAMP_SERVER_TOKEN_FILE: tokenFile },
      async () => {
        const target = await resolveServeUpstream({
          engine: "v3",
          commandPath: ["data", "get"],
          markerServerAddress: "http://elsewhere.test:9090",
          credentialRepository: repo,
          getCaCerts: noCaCerts,
        });
        assert(target !== undefined);
        assertEquals(target.serverUrl, "http://elsewhere.test:9090");
        assertEquals(target.token, undefined);
        assertEquals(target.hasToken, false);
      },
    );
  });
});

Deno.test("resolveServeUpstream: SWAMP_SERVER_TOKEN without a matching SWAMP_SERVER_URL is not sent", async () => {
  await withTemp(async (dir) => {
    const repo = new FileServerCredentialRepository({ configDir: dir });
    await withMockedEnv(
      {
        ...UNSET_ENV,
        SWAMP_SERVE_URL: "http://serve.test:9090",
        SWAMP_SERVER_URL: "http://other.test:9090",
        SWAMP_SERVER_TOKEN: "other.secret",
      },
      async () => {
        const target = await resolveServeUpstream({
          engine: "v3",
          commandPath: ["data", "get"],
          credentialRepository: repo,
          getCaCerts: noCaCerts,
        });
        assert(target !== undefined);
        assertEquals(target.serverUrl, "http://serve.test:9090");
        assertEquals(target.token, undefined);
      },
    );
  });
});

Deno.test("resolveServeUpstream: a matching env address uses SWAMP_SERVER_TOKEN_FILE over servers.json", async () => {
  await withTemp(async (dir) => {
    const tokenFile = await writeTokenFile(dir, "file.secret");
    const repo = await storedCredential(
      dir,
      "http://serve.test:9090",
      "stored.secret",
    );
    for (
      const envName of ["SWAMP_SERVE_URL", "SWAMP_SERVER_URL"] as const
    ) {
      await withMockedEnv(
        {
          ...UNSET_ENV,
          [envName]: "ws://serve.test:9090/",
          SWAMP_SERVER_TOKEN_FILE: tokenFile,
        },
        async () => {
          const target = await resolveServeUpstream({
            engine: "v3",
            commandPath: ["workflow", "run"],
            credentialRepository: repo,
            getCaCerts: noCaCerts,
          });
          assert(target !== undefined);
          assertEquals(target.token, "file.secret", envName);
        },
      );
    }
  });
});

Deno.test("resolveServeUpstream: an invalid address fails without echoing it", async () => {
  await withMockedEnv(
    { ...UNSET_ENV, SWAMP_SERVE_URL: "ftp://user:hunter2@serve.test" },
    async () => {
      const error = await assertRejects(
        () =>
          resolveServeUpstream({
            engine: "v3",
            commandPath: ["data", "get"],
            getCaCerts: noCaCerts,
          }),
        UserError,
      );
      assert(!error.message.includes("hunter2"));
    },
  );
});

Deno.test("serveUpstreamAppliesTo: excludes serve, worker and the storage-binding datastore commands", () => {
  assertEquals(serveUpstreamAppliesTo(["serve"]), false);
  assertEquals(serveUpstreamAppliesTo(["serve", "reload"]), false);
  assertEquals(serveUpstreamAppliesTo(["worker"]), false);
  assertEquals(serveUpstreamAppliesTo(["worker", "connect"]), false);
  assertEquals(serveUpstreamAppliesTo(["datastore"]), false);
  assertEquals(serveUpstreamAppliesTo(["datastore", "setup"]), false);
  assertEquals(serveUpstreamAppliesTo(["datastore", "sync"]), false);
  assertEquals(serveUpstreamAppliesTo(["datastore", "gc"]), false);
  assertEquals(serveUpstreamAppliesTo(["doctor", "datastores"]), false);
  assertEquals(serveUpstreamAppliesTo(["repo", "upgrade"]), false);
});

Deno.test("serveUpstreamAppliesTo: applies to ordinary repository commands", () => {
  assertEquals(serveUpstreamAppliesTo(["data", "get"]), true);
  assertEquals(serveUpstreamAppliesTo(["model", "method", "run"]), true);
  assertEquals(serveUpstreamAppliesTo(["behaviour", "method"]), true);
  assertEquals(serveUpstreamAppliesTo(["workflow", "run"]), true);
  assertEquals(serveUpstreamAppliesTo(["datastore", "type", "search"]), true);
  assertEquals(serveUpstreamAppliesTo(["doctor", "workflows"]), true);
});

Deno.test("serveUpstreamAppliesTo: an empty path or unknown word keeps the direct binding", () => {
  assertEquals(serveUpstreamAppliesTo([]), false);
  assertEquals(serveUpstreamAppliesTo(["no-such-command"]), false);
  assertEquals(serveUpstreamAppliesTo(["constructor"]), false);
});

Deno.test("serveUpstreamRunsLocally: the data plane runs locally with serve as its upstream; the control plane and excluded commands do not (swamp-club#3985)", () => {
  for (
    const path of [
      ["model", "method"],
      ["behavior", "create"],
      ["data", "get"],
      ["workflow", "run"],
      ["vault", "get"],
      ["report", "search"],
      ["summarise"],
    ]
  ) {
    assertEquals(serveUpstreamRunsLocally(path), true, path.join(" "));
  }
  for (
    const path of [
      ["access", "grant"],
      ["audit", "log"],
      ["doctor", "datastores"],
      ["datastore", "status"],
      ["serve"],
      ["worker", "start"],
      [],
    ]
  ) {
    assertEquals(serveUpstreamRunsLocally(path), false, path.join(" "));
  }
});
