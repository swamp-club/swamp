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

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { PolicySnapshotLoader } from "../domain/access/mod.ts";
import {
  authenticateServerToken,
  type ServerTokenAuthResult,
} from "./token_auth.ts";
import { parsePrincipal } from "../domain/access/principal.ts";
import {
  checkIpBurst,
  checkRateLimit,
  clearRateLimit,
  rateLimitKey,
} from "./rate_limiter.ts";

export interface AdminAuthDeps {
  readonly authMode: string;
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly policySnapshotLoader: PolicySnapshotLoader | null;
  readonly trustProxy: boolean;
}

export type AdminAuthResult =
  | { ok: true; authResult: ServerTokenAuthResult & { ok: true } }
  | { ok: false; response: Response };

export async function authenticateAdmin(
  req: Request,
  remoteAddr: string,
  deps: AdminAuthDeps,
): Promise<AdminAuthResult> {
  if (deps.authMode === "none") {
    return {
      ok: true,
      authResult: {
        ok: true,
        principalId: "@anonymous",
        collectives: [],
        groups: [],
      },
    };
  }

  const clientAddr = deps.trustProxy
    ? (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? remoteAddr)
    : remoteAddr;

  const ipBurst = checkIpBurst(clientAddr);
  if (!ipBurst.allowed) {
    return {
      ok: false,
      response: new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(ipBurst.retryAfterSeconds) },
      }),
    };
  }

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return {
      ok: false,
      response: new Response("Unauthorized: token required", { status: 401 }),
    };
  }

  const rlKey = rateLimitKey(token, clientAddr);
  const rateCheck = checkRateLimit(rlKey);
  if (!rateCheck.allowed) {
    return {
      ok: false,
      response: new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(rateCheck.retryAfterSeconds) },
      }),
    };
  }

  const authResult = await authenticateServerToken(
    token,
    deps.repoDir,
    deps.repoContext,
  );

  if (!authResult.ok) {
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  clearRateLimit(rlKey);

  if (!deps.policySnapshotLoader) {
    return {
      ok: false,
      response: Response.json({
        status: "error",
        message:
          "Authorization enforcement is enabled but no policy snapshot is available",
      }, { status: 403 }),
    };
  }

  const principal = parsePrincipal(authResult.principalId);
  const service = deps.policySnapshotLoader.decisionService;
  const decision = service.decide(
    {
      principal,
      collectives: [...authResult.collectives],
      groups: [...authResult.groups],
    },
    "admin",
    { kind: "access", name: "*", fields: {} },
  );

  if (!decision || decision.effect !== "allow") {
    return {
      ok: false,
      response: Response.json({
        status: "error",
        message: "Access denied: requires admin permission",
      }, { status: 403 }),
    };
  }

  return { ok: true, authResult };
}
