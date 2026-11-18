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

import { parsePrincipal } from "../domain/access/principal.ts";
import type {
  SignInCodeStore,
  SignInGrant,
} from "../domain/access/sign_in_code.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditOutcome } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { parseWorkspaceName } from "../domain/workspace/workspace_name.ts";
import { MAX_AUTH_BODY_BYTES } from "./device_auth_handler.ts";
import { displayPrincipal } from "./known_usernames.ts";
import { SIGN_IN_CODE_REDEEM_PATH } from "./protocol.ts";
import { readBodyWithLimit } from "./webhook.ts";

const MAX_CODE_LENGTH = 256;

export interface SignInCodeRedeemDeps {
  readonly codes: SignInCodeStore;
  readonly sourceIp: string;
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
}

/** the reply a workspace mints from; it carries no secret but is never cached */
export interface SignInCodeRedeemReply {
  readonly principal: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly collectives: readonly string[];
  readonly groups: readonly string[];
  readonly expiresAt: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function audit(
  deps: SignInCodeRedeemDeps,
  action: string,
  outcome: AuditOutcome,
  workspace: string,
  grant: SignInGrant | null,
): void {
  if (deps.auditEmitter === undefined) return;
  const principal = grant === null ? null : parsePrincipal(grant.principal);
  deps.auditEmitter.emit(buildAuditEvent({
    instanceId: deps.instanceId ?? "unknown",
    category: "auth",
    stage: "response",
    outcome,
    action,
    resourceKind: "workspace",
    resourceName: workspace,
    principalKind: principal?.kind ?? "anonymous",
    principalId: principal?.id ?? "anonymous",
    initiatedBy: principal === null ? "anonymous" : displayPrincipal(
      principal,
      grant?.username ? { [principal.id]: grant.username } : undefined,
    ),
    sourceIp: deps.sourceIp,
    requestId: crypto.randomUUID(),
  }));
}

/**
 * null for any other path; the redeemer is not authenticated, so every refusal
 * answers alike and names nothing about the code
 */
export async function handleSignInCodeRedeem(
  req: Request,
  deps: SignInCodeRedeemDeps,
): Promise<Response | null> {
  if (new URL(req.url).pathname !== SIGN_IN_CODE_REDEEM_PATH) return null;
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  const bytes = await readBodyWithLimit(req, MAX_AUTH_BODY_BYTES);
  if (bytes === null) return json(413, { error: "body_too_large" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(400, { error: "invalid_body" });
  }
  const { code, workspace } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof code !== "string" || code.length === 0 ||
    code.length > MAX_CODE_LENGTH || typeof workspace !== "string"
  ) {
    return json(400, { error: "invalid_body" });
  }
  let name: string;
  try {
    name = parseWorkspaceName(workspace);
  } catch {
    return json(400, { error: "invalid_body" });
  }
  const grant = await deps.codes.redeem(code, name);
  if (grant === null) {
    audit(deps, "auth.sign_in_code.refused", "denied", name, null);
    return json(404, { error: "not_found" });
  }
  audit(deps, "auth.sign_in_code.redeemed", "success", name, grant);
  const reply: SignInCodeRedeemReply = {
    principal: grant.principal,
    username: grant.username,
    email: grant.email,
    collectives: grant.collectives,
    groups: grant.groups,
    expiresAt: grant.expiresAt,
  };
  return json(200, reply);
}
