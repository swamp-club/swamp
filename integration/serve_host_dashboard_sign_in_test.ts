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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { validateDashboardSessionOrigin } from "../src/cli/commands/serve.ts";
import type { ControlPlaneStore } from "../src/domain/datastore/control_plane_store.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { authInfoBody } from "../src/serve/auth_exchange_handler.ts";
import { serveDashboardRoute } from "../src/serve/dashboard_assets.ts";
import { DashboardSessionCookie } from "../src/serve/dashboard_session_cookie.ts";
import {
  handleDashboardSession,
  resolveDashboardSessionForOrigin,
} from "../src/serve/dashboard_session_handler.ts";
import { ControlPlaneDashboardSessionStore } from "../src/serve/dashboard_session_store.ts";
import {
  createWorkspaceRouter,
  type WorkspaceRoute,
} from "../src/serve/host/workspace_router.ts";
import {
  limitDashboardSessionGuesses,
  resetRateLimitState,
} from "../src/serve/rate_limiter.ts";
import { extractDashboardSessionId } from "../src/serve/token_auth.ts";

await initializeLogging({});

const INDEX_HTML =
  '<!doctype html><script type="module" src="/dashboard/assets/app.js"></script>';

function memorySessions(): ControlPlaneDashboardSessionStore {
  const records = new Map<string, Uint8Array>();
  const store: ControlPlaneStore = {
    put: (key, data) => {
      records.set(key, data);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(records.get(key) ?? null),
    delete: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        [...records.keys()].filter((key) => key.startsWith(prefix)),
      ),
  };
  return new ControlPlaneDashboardSessionStore(store);
}

interface ServeSpec {
  readonly name: string;
  readonly hosted: boolean;
  readonly address: () => string;
  readonly trustedHost: () => string;
  readonly distDir?: string;
}

// wired as serve.ts wires it, with the trust flags a host gives each child
function serveHandler(spec: ServeSpec): Deno.ServeHandler<Deno.NetAddr> {
  const sessions = memorySessions();
  const ip = `dashboard-${crypto.randomUUID()}`;
  const token = `${spec.name}.secret`;
  const accepted = {
    ok: true as const,
    tokenName: spec.name,
    tokenCreatedAt: "2026-11-01T00:00:00.000Z",
  };
  const refused = {
    ok: false as const,
    response: new Response("Unauthorized", { status: 401 }),
  };
  const origin = (req: Request) =>
    validateDashboardSessionOrigin(req, false, true, [spec.trustedHost()]);
  return async (req) => {
    const cookie = DashboardSessionCookie.forServe(
      spec.address(),
      spec.hosted,
    );
    const path = new URL(req.url).pathname;
    if (path === "/auth/info") {
      return Response.json(authInfoBody(
        { mode: "token", oauthProvider: "https://club.example" },
        spec.hosted,
        !spec.hosted,
      ));
    }
    if (spec.distDir !== undefined) {
      const page = await serveDashboardRoute(spec.distDir, req);
      if (page !== null) return page;
    }
    // stands in for any route that reads this serve's data for a session
    if (path === "/whoami") {
      const id = extractDashboardSessionId(req, cookie.name);
      const session = id === null
        ? null
        : await resolveDashboardSessionForOrigin(
          id,
          req.headers.get("x-swamp-dashboard-origin"),
          sessions,
        );
      return session === null
        ? new Response(null, { status: 401 })
        : Response.json({ serve: spec.name });
    }
    const answered = await handleDashboardSession(req, {
      cookie,
      secure: origin(req).secure,
      originAllowed: (request) => origin(request).allowed,
      sessions,
      authenticateToken: (offered) =>
        Promise.resolve(offered === token ? accepted : refused),
      authenticateSession: (session) =>
        Promise.resolve(session.tokenName === spec.name ? accepted : refused),
      limitGuesses: (attempt) => limitDashboardSessionGuesses(ip, attempt),
    });
    return answered ?? new Response(null, { status: 404 });
  };
}

/** what a browser keeps: each cookie under its name, sent on paths under its Path */
class CookieJar {
  #cookies = new Map<string, { value: string; path: string }>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";").map((p) => p.trim());
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const path = attributes.find((a) => a.startsWith("Path="))?.slice(5) ??
        "/";
      if (attributes.includes("Max-Age=0")) this.#cookies.delete(name);
      else this.#cookies.set(name, { value: pair.slice(separator + 1), path });
    }
  }

  header(requestPath: string): string {
    return [...this.#cookies]
      .filter(([, { path }]) =>
        path === "/" || requestPath === path ||
        requestPath.startsWith(`${path}/`)
      )
      .map(([name, { value }]) => `${name}=${value}`)
      .join("; ");
  }

  names(): string[] {
    return [...this.#cookies.keys()].sort();
  }
}

interface Host {
  readonly base: string;
  readonly jar: CookieJar;
  request(path: string, init?: RequestInit): Promise<Response>;
}

async function withHost(fn: (host: Host) => Promise<void>): Promise<void> {
  const distDir = await Deno.makeTempDir({ prefix: "swamp-host-dashboard-" });
  const listen = (handler: Deno.ServeHandler<Deno.NetAddr>) =>
    Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handler);
  const shutdown = new AbortController();
  const servers: Deno.HttpServer<Deno.NetAddr>[] = [];
  try {
    await Deno.mkdir(join(distDir, "assets"));
    await Deno.writeTextFile(join(distDir, "index.html"), INDEX_HTML);
    await Deno.writeTextFile(join(distDir, "assets", "app.js"), "export {};");
    let base = "";
    const trustedHost = () => new URL(base).host;
    const root = listen(serveHandler({
      name: "root",
      hosted: false,
      address: () => base,
      trustedHost,
      distDir,
    }));
    const workspaces = new Map<string, WorkspaceRoute>();
    for (const name of ["team", "data"]) {
      const serve = listen(serveHandler({
        name,
        hosted: true,
        address: () => `${base}/w/${name}`,
        trustedHost,
      }));
      servers.push(serve);
      workspaces.set(name, { kind: "running", port: serve.addr.port });
    }
    workspaces.set("parked", { kind: "unavailable", state: "stopped" });
    const router = createWorkspaceRouter({
      directory: {
        workspace: (name) => workspaces.get(name),
        root: () => ({ kind: "running", port: root.addr.port }),
      },
      protocol: "http",
      trustProxy: false,
      sessionCookieName: (name) =>
        DashboardSessionCookie.forAddress(`${base}/w/${name}`).name,
      signal: shutdown.signal,
    });
    const front = listen((req, info) => router.handle(req, info));
    servers.push(root, front);
    base = `http://127.0.0.1:${front.addr.port}`;
    const jar = new CookieJar();
    resetRateLimitState();
    await fn({
      base,
      jar,
      async request(path, init = {}) {
        const headers = new Headers(init.headers);
        headers.set("origin", base);
        headers.set("x-swamp-dashboard-origin", base);
        const cookies = jar.header(path);
        if (cookies !== "") headers.set("cookie", cookies);
        const response = await fetch(`${base}${path}`, { ...init, headers });
        jar.store(response);
        return response;
      },
    });
  } finally {
    shutdown.abort();
    for (const server of servers) await server.shutdown();
    if (Deno.build.os === "windows") {
      await Deno.remove(distDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(distDir, { recursive: true });
    }
  }
}

function signIn(host: Host, prefix: string, token: string): Promise<Response> {
  return host.request(`${prefix}/auth/dashboard/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function whoami(host: Host, prefix: string): Promise<string | number> {
  const response = await host.request(`${prefix}/whoami`);
  if (!response.ok) {
    await response.body?.cancel();
    return response.status;
  }
  return (await response.json()).serve;
}

Deno.test("serve host dashboard: the root serves a workspace's pages and their assets", async () => {
  await withHost(async (host) => {
    const page = await host.request("/dashboard/w/team/models");
    assertEquals(page.status, 200);
    assertEquals(await page.text(), INDEX_HTML);
    const asset = await host.request("/dashboard/assets/app.js");
    assertEquals(asset.status, 200);
    assertEquals(await asset.text(), "export {};");
    const own = await host.request("/dashboard/");
    assertEquals(await own.text(), INDEX_HTML);
  });
});

Deno.test("serve host dashboard: a workspace's /auth/info is a serve's, never the local dashboard's", async () => {
  await withHost(async (host) => {
    const info = await (await host.request("/w/team/auth/info")).json();
    assertEquals(info, { mode: "token", exchange: true });
    const root = await (await host.request("/auth/info")).json();
    assertEquals(root, { mode: "token", hostRoot: true });
  });
});

Deno.test("serve host dashboard: the root and two workspaces keep their own sessions", async () => {
  await withHost(async (host) => {
    assertEquals((await signIn(host, "", "root.secret")).status, 204);
    assertEquals((await signIn(host, "/w/team", "team.secret")).status, 204);
    assertEquals((await signIn(host, "/w/data", "data.secret")).status, 204);
    assertEquals(host.jar.names(), [
      "swamp-dashboard-session",
      "swamp-dashboard-session_2Fw_2Fdata",
      "swamp-dashboard-session_2Fw_2Fteam",
    ]);
    assertEquals(await whoami(host, ""), "root");
    assertEquals(await whoami(host, "/w/team"), "team");
    assertEquals(await whoami(host, "/w/data"), "data");

    const crossed = await signIn(host, "/w/team", "data.secret");
    assertEquals(crossed.status, 401);
    await crossed.body?.cancel();
    assertEquals(await whoami(host, "/w/team"), "team");
  });
});

Deno.test("serve host dashboard: signing out of one workspace leaves the root and the other", async () => {
  await withHost(async (host) => {
    for (
      const [prefix, token] of [
        ["", "root.secret"],
        ["/w/team", "team.secret"],
        ["/w/data", "data.secret"],
      ]
    ) {
      const response = await signIn(host, prefix, token);
      assertEquals(response.status, 204);
    }
    const out = await host.request("/w/team/auth/dashboard/session", {
      method: "DELETE",
    });
    assertEquals(out.status, 204);
    assertEquals(await whoami(host, "/w/team"), 401);
    assertEquals(await whoami(host, ""), "root");
    assertEquals(await whoami(host, "/w/data"), "data");
    const restored = await host.request("/w/data/auth/dashboard/session");
    assertEquals(await restored.json(), { authenticated: true });
  });
});

Deno.test("serve host dashboard: a workspace sees only its own cookie, not the root's", async () => {
  await withHost(async (host) => {
    assertEquals((await signIn(host, "", "root.secret")).status, 204);
    assertEquals(await whoami(host, "/w/team"), 401);
    const restore = await host.request("/w/team/auth/dashboard/session");
    assertEquals(restore.status, 401);
    await restore.body?.cancel();
  });
});

Deno.test("serve host dashboard: an unknown workspace is 404 and a stopped one is 503 with its state", async () => {
  await withHost(async (host) => {
    const unknown = await host.request("/w/nope/auth/info");
    assertEquals(unknown.status, 404);
    assert(typeof (await unknown.json()).error === "string");
    const stopped = await host.request("/w/parked/auth/info");
    assertEquals(stopped.status, 503);
    const body = await stopped.json();
    assertEquals(body.state, "stopped");
    assertStringIncludes(body.error, "not running");
  });
});

Deno.test("serve host dashboard: the switcher's root check answers 401 to a browser signed in only to a workspace, and the root's session once it signs in there", async () => {
  await withHost(async (host) => {
    assertEquals((await signIn(host, "/w/team", "team.secret")).status, 204);
    const info = await (await host.request("/auth/info")).json();
    assertEquals(info.hostRoot, true);
    const before = await host.request("/auth/dashboard/session");
    assertEquals(before.status, 401);
    await before.body?.cancel();

    assertEquals((await signIn(host, "", "root.secret")).status, 204);
    const after = await host.request("/auth/dashboard/session");
    assertEquals(await after.json(), { authenticated: true });
    // the root's socket and reads go to its own paths, which carry its cookie
    assertEquals(await whoami(host, ""), "root");
    assertEquals(await whoami(host, "/w/team"), "team");
  });
});
