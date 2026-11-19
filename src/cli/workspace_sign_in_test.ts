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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import type { ServerCredential } from "../domain/auth/server_credential.ts";
import {
  hasWorkspaceSignInGap,
  loginHintFor,
} from "../infrastructure/auth/workspace_sign_in_notes.ts";
import { ProcessRuntime } from "../infrastructure/runtime/process_runtime.ts";
import {
  NOT_A_HOST_ROOT_CODE,
  SIGN_IN_NOT_OFFERED_CODE,
  SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
  SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
  SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
} from "../serve/protocol.ts";
import {
  type HostTokenCheck,
  type JsonReply,
  localExpiry,
  RENEW_MARGIN_MS,
  signInToWorkspace,
  type WorkspaceSignInDeps,
  workspaceTokenFor,
} from "./workspace_sign_in.ts";

const HOST = "https://host.example/swamp";
const WORKSPACE = `${HOST}/w/team`;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const SERVE_EXPIRES_AT = "2026-12-18T12:00:00.000Z";
const HOST_CREDENTIAL: ServerCredential = {
  serverUrl: HOST,
  tokenName: "a@example.com",
  token: "root.secret",
  principalId: "user:a",
  obtainedAt: "2026-11-01T00:00:00.000Z",
};
// SHA-256 of HOST_CREDENTIAL's obtainedAt, a newline and its token
const HOST_SIGN_IN_DIGEST =
  "17a69c165fce39e131deb25a55a7fbe4a2a313f4e98265053796f6945d040df4";

interface Recorded {
  readonly urls: string[];
  readonly inits: RequestInit[];
  readonly codeRequests: { host: string; token: string; name: string }[];
  readonly hostChecks: string[];
  readonly saved: ServerCredential[];
}

function fakeDeps(
  overrides: {
    stored?: Record<string, ServerCredential | undefined>;
    envPairNames?: (url: string) => boolean;
    authInfo?: JsonReply | Error;
    exchange?: JsonReply | Error;
    signInCode?: () => Promise<{ data: { code: string } }>;
    hostCheck?: HostTokenCheck;
    now?: () => number;
  } = {},
): { deps: WorkspaceSignInDeps; recorded: Recorded } {
  const recorded: Recorded = {
    urls: [],
    inits: [],
    codeRequests: [],
    hostChecks: [],
    saved: [],
  };
  const stored: Record<string, ServerCredential | undefined> = {
    [HOST]: HOST_CREDENTIAL,
    ...overrides.stored,
  };
  const deps: WorkspaceSignInDeps = {
    credentials: {
      get: (url) => Promise.resolve(stored[url] ?? null),
      save: (credential) => {
        recorded.saved.push(credential);
        stored[credential.serverUrl] = credential;
        return Promise.resolve();
      },
    },
    envPairNames: overrides.envPairNames ?? (() => false),
    checkHostToken: (_host, token) => {
      recorded.hostChecks.push(token);
      return Promise.resolve(overrides.hostCheck ?? { kind: "accepted" });
    },
    requestSignInCode: (host, token, name) => {
      recorded.codeRequests.push({ host, token, name });
      return overrides.signInCode?.() ??
        Promise.resolve({ data: { code: "code-1" } });
    },
    fetchJson: (url, init) => {
      recorded.urls.push(url);
      recorded.inits.push(init);
      const reply = url.endsWith("/auth/info")
        ? overrides.authInfo ??
          { status: 200, date: null, body: { mode: "oauth", exchange: true } }
        : overrides.exchange ?? {
          status: 200,
          date: new Date(NOW).toUTCString(),
          body: {
            token: "ws.secret",
            expiresAt: SERVE_EXPIRES_AT,
            principal: { id: "user:a", email: "a@example.com", username: "a" },
          },
        };
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(reply);
    },
    headers: { "x-proxy": "1" },
    now: overrides.now ?? (() => NOW),
  };
  return { deps, recorded };
}

function inOwnRuntime<T>(fn: () => Promise<T>): Promise<T> {
  return new ProcessRuntime(crypto.randomUUID()).run(fn);
}

Deno.test("signInToWorkspace: exchanges a host token for a workspace token and stores it", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    assertEquals(await signInToWorkspace(WORKSPACE, deps), "ws.secret");
    assertEquals(recorded.codeRequests, [{
      host: HOST,
      token: "root.secret",
      name: "team",
    }]);
    assertEquals(recorded.urls, [
      `${WORKSPACE}/auth/info`,
      `${WORKSPACE}/auth/exchange`,
    ]);
    assertEquals(recorded.saved, [{
      serverUrl: WORKSPACE,
      tokenName: "a@example.com",
      token: "ws.secret",
      principalId: "user:a",
      displayName: "a",
      obtainedAt: new Date(NOW).toISOString(),
      expiresAt: SERVE_EXPIRES_AT,
      hostSignInDigest: HOST_SIGN_IN_DIGEST,
    }]);
  });
});

Deno.test("signInToWorkspace: never sends the host token to the workspace", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    await signInToWorkspace(WORKSPACE, deps);
    for (const init of recorded.inits) {
      const headers = new Headers(init.headers);
      assertEquals(headers.get("authorization"), null);
      assertEquals(JSON.stringify(init).includes("root.secret"), false);
      assertEquals(init.redirect, "manual");
      assertEquals(headers.get("x-proxy"), "1");
    }
    assertEquals(
      JSON.parse(String(recorded.inits[1].body)),
      { code: "code-1" },
    );
  });
});

Deno.test("signInToWorkspace: an address with no workspace segment is not signed in", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    assertEquals(await signInToWorkspace(HOST, deps), undefined);
    assertEquals(recorded.urls, []);
  });
});

Deno.test("signInToWorkspace: a workspace that offers no exchange is not signed in and records no gap", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({
      stored: {},
      authInfo: { status: 200, date: null, body: { mode: "oauth" } },
    });
    assertEquals(await signInToWorkspace(WORKSPACE, deps), undefined);
    assertEquals(recorded.codeRequests, []);
    assertEquals(
      loginHintFor(WORKSPACE),
      `Authentication failed — run: swamp auth server-login --server ${WORKSPACE}`,
    );
  });
});

Deno.test("signInToWorkspace: no host token records the gap the login hint names", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({ stored: { [HOST]: undefined } });
    assertEquals(await signInToWorkspace(WORKSPACE, deps), undefined);
    assertEquals(recorded.codeRequests, []);
    assertStringIncludes(
      loginHintFor(WORKSPACE),
      `swamp auth server-login --server ${HOST} (one sign-in`,
    );
  });
});

Deno.test("signInToWorkspace: a host token from the SWAMP_SERVER_TOKEN pair is never exchanged, even with one stored", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({
      envPairNames: (url) => url === HOST,
    });
    assertEquals(await signInToWorkspace(WORKSPACE, deps), undefined);
    assertEquals(recorded.codeRequests, []);
    assertEquals(recorded.saved, []);
    assertStringIncludes(loginHintFor(WORKSPACE), "SWAMP_SERVER_TOKEN");
  });
});

Deno.test("signInToWorkspace: a network failure at any step is not eligible", async () => {
  for (
    const overrides of [
      { authInfo: new TypeError("connection refused") },
      { authInfo: { status: 502, date: null, body: null } },
      { signInCode: () => Promise.reject(new UserError("Could not connect")) },
      {
        signInCode: () =>
          Promise.reject(new UserError("too many", "too_many_sign_in_codes")),
      },
      { exchange: new TypeError("connection reset") },
      { exchange: { status: 502, date: null, body: { error: "x" } } },
      { exchange: { status: 429, date: null, body: { error: "x" } } },
      { exchange: { status: 404, date: null, body: { error: "x" } } },
    ]
  ) {
    await inOwnRuntime(async () => {
      const { deps, recorded } = fakeDeps(overrides);
      assertEquals(await signInToWorkspace(WORKSPACE, deps), undefined);
      assertEquals(recorded.saved, []);
    });
  }
});

Deno.test("signInToWorkspace: a host that refuses its own token says to sign in to the host, without asking over the socket", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({ hostCheck: { kind: "refused" } });
    const error = await assertRejects(
      () => signInToWorkspace(WORKSPACE, deps),
      UserError,
    );
    assertStringIncludes(error.message, `refused your sign-in`);
    assertStringIncludes(
      error.message,
      `swamp auth server-login --server ${HOST}`,
    );
    assertEquals(recorded.hostChecks, ["root.secret"]);
    assertEquals(recorded.codeRequests, []);
  });
});

Deno.test("signInToWorkspace: a host turning the token away for now says how long, without asking over the socket", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({
      hostCheck: { kind: "limited", retryAfterSeconds: 42 },
    });
    const error = await assertRejects(
      () => signInToWorkspace(WORKSPACE, deps),
      UserError,
    );
    assertEquals(error.code, "rate_limited");
    assertStringIncludes(error.message, "for 42s");
    assertStringIncludes(
      error.message,
      `swamp auth server-login --server ${HOST}`,
    );
    assertEquals(recorded.codeRequests, []);
  });
});

Deno.test("signInToWorkspace: a host whose HTTP route gives no answer is still asked over the socket", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({ hostCheck: { kind: "unknown" } });
    assertEquals(await signInToWorkspace(WORKSPACE, deps), "ws.secret");
    assertEquals(recorded.codeRequests.length, 1);
  });
});

Deno.test("signInToWorkspace: each root refusal is reported with the root's reason", async () => {
  for (
    const code of [
      NOT_A_HOST_ROOT_CODE,
      SIGN_IN_NOT_OFFERED_CODE,
      SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
      SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
      SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
    ]
  ) {
    await inOwnRuntime(async () => {
      const refusal = Object.assign(new UserError(`${code}: why`, code), {
        serverMessage: "why",
      });
      const { deps } = fakeDeps({ signInCode: () => Promise.reject(refusal) });
      const error = await assertRejects(
        () => signInToWorkspace(WORKSPACE, deps),
        UserError,
      );
      assertEquals(error.code, code);
      assertStringIncludes(
        error.message,
        `The host at ${HOST} refused a sign-in code for the workspace team: why`,
      );
    });
  }
});

Deno.test("signInToWorkspace: a refused code and a refused principal say which", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps({
      exchange: { status: 401, date: null, body: { error: "code_refused" } },
    });
    const error = await assertRejects(
      () => signInToWorkspace(WORKSPACE, deps),
      UserError,
    );
    assertStringIncludes(error.message, "refused the sign-in code");
  });
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps({
      exchange: {
        status: 403,
        date: null,
        body: { error: "not_admitted", reason: "not in the collective" },
      },
    });
    const error = await assertRejects(
      () => signInToWorkspace(WORKSPACE, deps),
      UserError,
    );
    assertStringIncludes(error.message, "does not admit you");
    assertStringIncludes(error.message, "not in the collective");
    assertStringIncludes(error.message, "Signing in to the host again");
  });
});

Deno.test("signInToWorkspace: one attempt per address per process", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    await Promise.all([
      signInToWorkspace(WORKSPACE, deps),
      signInToWorkspace(WORKSPACE, deps),
    ]);
    await signInToWorkspace(WORKSPACE, deps);
    assertEquals(recorded.codeRequests.length, 1);
  });
});

Deno.test("signInToWorkspace: a token that cannot be saved still serves the command", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps();
    const unsaved: WorkspaceSignInDeps = {
      ...deps,
      credentials: {
        get: deps.credentials.get,
        save: () => Promise.reject(new Deno.errors.PermissionDenied("ro")),
      },
    };
    assertEquals(await signInToWorkspace(WORKSPACE, unsaved), "ws.secret");
  });
});

Deno.test("signInToWorkspace: a malformed exchange reply stores nothing", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({
      exchange: {
        status: 200,
        date: null,
        body: { token: "t", expiresAt: "soon" },
      },
    });
    assertEquals(await signInToWorkspace(WORKSPACE, deps), undefined);
    assertEquals(recorded.saved, []);
  });
});

function exchanged(expiresAt: number, obtainedAt: number): ServerCredential {
  return {
    serverUrl: WORKSPACE,
    tokenName: "a@example.com",
    token: "old.secret",
    principalId: "user:a",
    obtainedAt: new Date(obtainedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    hostSignInDigest: HOST_SIGN_IN_DIGEST,
  };
}

Deno.test("workspaceTokenFor: no token found signs in", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps();
    assertEquals(await workspaceTokenFor(WORKSPACE, null, deps), "ws.secret");
  });
});

Deno.test("workspaceTokenFor: a token with no expiry is used as it is", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    const fromLogin = { ...exchanged(0, 0), expiresAt: undefined };
    assertEquals(
      await workspaceTokenFor(WORKSPACE, fromLogin, deps),
      "old.secret",
    );
    assertEquals(recorded.urls, []);
  });
});

Deno.test("workspaceTokenFor: a valid exchanged token outside the margin is used as it is", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    const found = exchanged(NOW + RENEW_MARGIN_MS * 2, NOW - 1000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "old.secret");
    assertEquals(recorded.urls, []);
  });
});

Deno.test("workspaceTokenFor: an expired exchanged token is replaced before it is sent", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    const found = exchanged(NOW - 1000, NOW - 30 * 86_400_000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "ws.secret");
    assertEquals(recorded.saved.length, 1);
  });
});

Deno.test("workspaceTokenFor: an expired token whose renewal is refused fails the command", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps({ hostCheck: { kind: "refused" } });
    const found = exchanged(NOW - 1000, NOW - 30 * 86_400_000);
    await assertRejects(
      () => workspaceTokenFor(WORKSPACE, found, deps),
      UserError,
    );
  });
});

Deno.test("workspaceTokenFor: an expired token is not sent when it cannot be replaced", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps({ authInfo: new TypeError("unreachable") });
    const found = exchanged(NOW - 1000, NOW - 30 * 86_400_000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), undefined);
  });
});

Deno.test("workspaceTokenFor: a token inside the margin is renewed early", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps();
    const found = exchanged(NOW + 60_000, NOW - 30 * 86_400_000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "ws.secret");
  });
});

Deno.test("workspaceTokenFor: a refused early renewal keeps the still-valid token", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps({
      exchange: { status: 403, date: null, body: { error: "not_admitted" } },
    });
    const found = exchanged(NOW + 60_000, NOW - 30 * 86_400_000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "old.secret");
  });
});

Deno.test("workspaceTokenFor: a token granted less than the margin is not renewed early", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps();
    const found = exchanged(NOW + 60_000, NOW - 60_000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "old.secret");
    assertEquals(recorded.urls, []);
  });
});

Deno.test("workspaceTokenFor: a valid token from another host sign-in is replaced through the current one", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({
      stored: { [HOST]: { ...HOST_CREDENTIAL, token: "bob.rotated" } },
    });
    const found = exchanged(NOW + 30 * 86_400_000, NOW - 1000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "ws.secret");
    assertEquals(recorded.codeRequests[0].token, "bob.rotated");
    assertEquals(
      recorded.saved[0].hostSignInDigest,
      "76a6d474a8a42427985956e39352cd7bc7dc7252518040ca2e4d48ac9413ef1f",
    );
  });
});

Deno.test("workspaceTokenFor: a valid token is not sent once its host token is gone", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({ stored: { [HOST]: undefined } });
    const found = exchanged(NOW + 30 * 86_400_000, NOW - 1000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), undefined);
    assertEquals(recorded.codeRequests, []);
    assertStringIncludes(
      loginHintFor(WORKSPACE),
      `swamp auth server-login --server ${HOST}`,
    );
  });
});

Deno.test("workspaceTokenFor: an exchanged token that names no host token is replaced", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps();
    const found = {
      ...exchanged(NOW + 30 * 86_400_000, NOW - 1000),
      hostSignInDigest: undefined,
    };
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "ws.secret");
  });
});

Deno.test("workspaceTokenFor: signing in to the host again with the same token replaces a valid workspace token", async () => {
  await inOwnRuntime(async () => {
    const { deps, recorded } = fakeDeps({
      stored: {
        [HOST]: { ...HOST_CREDENTIAL, obtainedAt: "2026-11-19T00:00:00.000Z" },
      },
    });
    const found = exchanged(NOW + 30 * 86_400_000, NOW - 1000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "ws.secret");
    assertEquals(recorded.codeRequests[0].token, "root.secret");
    assertEquals(
      recorded.saved[0].hostSignInDigest,
      "2d3c52700d035fd7a8ce4acbbf2258d9bed4490fe218db83bf1e98e03816f5ba",
    );
  });
});

Deno.test("workspaceTokenFor: an exchanged token sent is noted for the refusal hint, and is not a gap", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps();
    const found = exchanged(NOW + RENEW_MARGIN_MS * 2, NOW - 1000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), "old.secret");
    assertEquals(hasWorkspaceSignInGap(WORKSPACE), false);
    assertStringIncludes(
      loginHintFor(WORKSPACE),
      `sign in to the host again to replace it: swamp auth server-login --server ${HOST}`,
    );
  });
});

Deno.test("workspaceTokenFor: a token stored by server-login is not noted as exchanged", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps();
    const fromLogin = { ...exchanged(0, 0), expiresAt: undefined };
    assertEquals(
      await workspaceTokenFor(WORKSPACE, fromLogin, deps),
      "old.secret",
    );
    assertEquals(
      loginHintFor(WORKSPACE),
      `Authentication failed — run: swamp auth server-login --server ${WORKSPACE}`,
    );
  });
});

Deno.test("workspaceTokenFor: a token from another host sign-in is not sent when it cannot be replaced", async () => {
  await inOwnRuntime(async () => {
    const { deps } = fakeDeps({
      stored: { [HOST]: { ...HOST_CREDENTIAL, token: "bob.rotated" } },
      authInfo: new TypeError("unreachable"),
    });
    const found = exchanged(NOW + 30 * 86_400_000, NOW - 1000);
    assertEquals(await workspaceTokenFor(WORKSPACE, found, deps), undefined);
  });
});

Deno.test("localExpiry: counts the lifetime the serve granted from when the token arrived", () => {
  const serveNow = Date.parse("2026-11-18T12:10:00.000Z");
  const expiresAt = serveNow + 3_600_000;
  assertEquals(
    localExpiry(
      NOW,
      new Date(expiresAt).toISOString(),
      new Date(serveNow).toUTCString(),
    ),
    NOW + 3_600_000,
  );
});

Deno.test("localExpiry: an absent or unparseable Date header leaves the expiry as given", () => {
  assertEquals(
    localExpiry(NOW, SERVE_EXPIRES_AT, null),
    Date.parse(SERVE_EXPIRES_AT),
  );
  assertEquals(
    localExpiry(NOW, SERVE_EXPIRES_AT, "not a date"),
    Date.parse(SERVE_EXPIRES_AT),
  );
});

Deno.test("localExpiry: a Date after the expiry gives no lifetime, and a wild one is capped", () => {
  const expiresAt = NOW + 3_600_000;
  assertEquals(
    localExpiry(
      NOW,
      new Date(expiresAt).toISOString(),
      new Date(expiresAt + 1000).toUTCString(),
    ),
    NOW,
  );
  assertEquals(
    localExpiry(
      NOW,
      new Date(expiresAt).toISOString(),
      new Date(0).toUTCString(),
    ),
    NOW + 3_600_000 + 24 * 60 * 60 * 1000,
  );
});
