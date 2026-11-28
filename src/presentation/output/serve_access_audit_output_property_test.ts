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
import fc from "fast-check";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import type { Group } from "../../domain/models/access/group_model.ts";
import type { AccessDecision } from "../../domain/access/access_decision_service.ts";
import type { AuditEntry } from "../../domain/audit/audit_entry.ts";
import type {
  AccessGroupIdpEntry,
  AuditAlertsResponse,
  AuditQueryResponse,
  AuditReportResponse,
  AuditRotateKeyResponse,
  AuditVerifyResponse,
} from "../../serve/protocol.ts";
import type { DelegationView } from "../../libswamp/access/delegation_list.ts";
import type { IntegrationView } from "../../libswamp/access/integration_list.ts";
import type { ServerTokenCreateData } from "../../libswamp/access/token_create.ts";
import type { ServerTokenListData } from "../../libswamp/access/token_list.ts";
import type { ServerTokenRevokeData } from "../../libswamp/access/token_revoke.ts";
import type { ServerTokenRevealData } from "../../libswamp/access/token_reveal.ts";
import type { ServerTokenRotateData } from "../../libswamp/access/token_rotate.ts";
import {
  type AccessCanIResult,
  createAccessCanIRenderer,
} from "../renderers/access_can_i.ts";
import {
  type AccessCheckResult,
  createAccessCheckRenderer,
} from "../renderers/access_check.ts";
import { createAccessGrantListRenderer } from "../renderers/access_grant.ts";
import {
  createAccessGroupIdpRenderer,
  createAccessGroupListRenderer,
} from "../renderers/access_group.ts";
import { createAuditTimelineRenderer } from "../renderers/audit_timeline.ts";
import {
  renderDelegation,
  renderDelegationEnded,
  renderDelegationList,
} from "./access_delegation_output.ts";
import {
  renderIntegration,
  renderIntegrationList,
  renderIntegrationRegistered,
  renderIntegrationRevoked,
} from "./access_integration_output.ts";
import {
  renderServerTokenCreate,
  renderServerTokenList,
  renderServerTokenReveal,
  renderServerTokenRevoke,
  renderServerTokenRotate,
} from "./access_token_output.ts";
import { renderAuditAlerts } from "./audit_alerts_output.ts";
import { createAuditExportRenderer } from "./audit_export_output.ts";
import { renderAuditLog } from "./audit_log_output.ts";
import { renderAuditReport } from "./audit_report_output.ts";
import { renderAuditRotateKey } from "./audit_rotate_key_output.ts";
import { renderAuditVerify } from "./audit_verify_output.ts";
import {
  renderServeCheckConfig,
  type ServeCheckConfigData,
} from "./serve_check_config_output.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const unit = fc.oneof(
  fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
  fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;t\x07"),
  fc.fullUnicode(),
);
const text = fc.string({ unit });
const short = (maxLength: number) => fc.string({ unit, maxLength });
// a table trims its last column, so a value printed there ends in a visible character
const lastColumn = text.map((value) => `${value}.`);
const nonEmpty = text.filter((value) => value.length > 0);

const RUNS = { numRuns: 50 };

// the serve reply is cast to these types unchecked, so every field is arbitrary text
function cast<T>(value: unknown): T {
  return value as T;
}

function assertEscaped(
  output: string,
  printed: readonly string[],
  printedAsText: readonly string[] = [],
): void {
  assertNoControlCharacters(output);
  for (const value of printed) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
  for (const value of printedAsText) {
    const escaped = escapeControlCharactersInText(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

const decisionArb = fc.record({
  action: text,
  resource: text,
  via: text,
  condition: text,
  effect: text,
  grantId: text,
});

Deno.test("access can-i renderer: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(
      text,
      text,
      text,
      fc.array(decisionArb, { minLength: 2, maxLength: 3 }),
      fc.record({ vault: text, action: text, triggerScope: text }),
      (principal, action, resource, decisions, run) => {
        const runVaultAccess = {
          ...run,
          allowed: true,
          restricted: true,
          rule: "grant",
          reason: "r",
        };
        const query = cast<AccessCanIResult>({
          principal,
          decisions: decisions.map((d) => ({ ...d, dependsOn: ["x"] })),
          query: { action, resource },
          runVaultAccess,
        });
        assertEscaped(
          captureRaw(() => createAccessCanIRenderer("log").render(query)),
          [
            action,
            resource,
            ...decisions.flatMap((d) => [d.via, d.condition]),
            run.vault,
            run.action,
            run.triggerScope,
          ],
        );
        assertEscaped(
          captureRaw(() =>
            createAccessCanIRenderer("log").render({
              ...query,
              decisions: [],
            })
          ),
          [principal, action, resource],
        );
        assertEscaped(
          captureRaw(() =>
            createAccessCanIRenderer("log").render({
              ...query,
              query: undefined,
            })
          ),
          [
            principal,
            ...decisions.flatMap((d) => [
              d.resource,
              d.action,
              d.via,
              d.condition,
            ]),
          ],
        );
        assertEquals(
          JSON.parse(
            captureRaw(() =>
              createAccessCanIRenderer("json").render({
                ...query,
                query: undefined,
              })
            ),
          ),
          { principal, decisions: query.decisions },
        );
      },
    ),
    RUNS,
  );
});

Deno.test("access check renderer: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(
      fc.record({
        subject: text,
        action: text,
        resource: text,
        method: nonEmpty,
        client: text,
      }),
      fc.array(
        fc.record({
          kind: text,
          name: text,
          condition: text,
          effect: text,
          grantId: text,
        }),
        { minLength: 2, maxLength: 3 },
      ),
      fc.record({ vault: text, triggerScope: text }),
      (r, decisions, run) => {
        const result = cast<AccessCheckResult>({
          ...r,
          collectives: [],
          decisions: decisions.map((d) =>
            cast<AccessDecision>({
              effect: d.effect,
              grantId: d.grantId,
              subject: { kind: d.kind, name: d.name },
              condition: d.condition,
            })
          ),
          runVaultAccess: {
            ...run,
            action: "read",
            allowed: false,
            restricted: true,
            rule: "grant",
            reason: "r",
          },
        });
        assertEscaped(
          captureRaw(() => createAccessCheckRenderer("log").render(result)),
          [
            r.action,
            `${r.resource} method ${r.method}`,
            r.client,
            ...decisions.flatMap((d) => [`${d.kind}:${d.name}`, d.condition]),
            run.vault,
            run.triggerScope,
          ],
        );
        assertEscaped(
          captureRaw(() =>
            createAccessCheckRenderer("log").render({
              ...result,
              decisions: [],
            })
          ),
          [r.subject, r.action, `${r.resource} method ${r.method}`],
        );
      },
    ),
    RUNS,
  );
});

const grantArb = fc.record({
  id: text,
  kind: text,
  name: text,
  displayName: text,
  effect: text,
  actions: fc.array(text, { minLength: 1, maxLength: 2 }),
  resourceKind: text,
  pattern: text,
  methods: fc.array(text, { minLength: 1, maxLength: 2 }),
  condition: text,
  source: text,
});

Deno.test("access grant and group renderers: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(
      grantArb,
      fc.record({
        name: text,
        createdByKind: text,
        createdById: text,
        memberKind: text,
        memberId: text,
        createdAt: text,
      }),
      fc.record({ name: text, lastSeenAt: text }),
      (g, grp, idp) => {
        const grant = cast<Grant>({
          id: g.id,
          subject: { kind: g.kind, name: g.name },
          effect: g.effect,
          actions: g.actions,
          resource: { kind: g.resourceKind, pattern: g.pattern },
          methods: g.methods,
          condition: g.condition,
          source: g.source,
        });
        assertEscaped(
          captureRaw(() =>
            createAccessGrantListRenderer("log").render([grant])
          ),
          [
            g.id,
            `${g.kind}:${g.name}`,
            g.effect,
            g.actions.join(","),
            `${g.resourceKind}:${g.pattern}`,
            g.methods.join(","),
            g.condition,
            g.source,
          ],
        );
        const userGrant = cast<Grant>({
          ...grant,
          subject: { kind: "user", name: "u" },
        });
        assertEscaped(
          captureRaw(() =>
            createAccessGrantListRenderer("log").render([userGrant], {
              u: g.displayName || "d",
            })
          ),
          [`user:${g.displayName || "d"}`],
        );
        assertEquals(
          JSON.parse(
            captureRaw(() =>
              createAccessGrantListRenderer("json").render([grant])
            ),
          ),
          [grant],
        );

        const group = cast<Group>({
          name: grp.name,
          createdBy: { kind: grp.createdByKind, id: grp.createdById },
          members: [{ kind: grp.memberKind, id: grp.memberId }],
          createdAt: grp.createdAt,
        });
        assertEscaped(
          captureRaw(() =>
            createAccessGroupListRenderer("log").renderList([group])
          ),
          [grp.name, `${grp.createdByKind}:${grp.createdById}`],
        );
        assertEscaped(
          captureRaw(() =>
            createAccessGroupListRenderer("log").renderMembers(group)
          ),
          [grp.name, `${grp.memberKind}:${grp.memberId}`],
        );
        assertEscaped(
          captureRaw(() =>
            createAccessGroupListRenderer("log").renderMembers({
              ...group,
              members: [],
            })
          ),
          [grp.name],
        );
        assertEquals(
          JSON.parse(
            captureRaw(() =>
              createAccessGroupListRenderer("json").renderMembers(group)
            ),
          ),
          group,
        );
        const entry = cast<AccessGroupIdpEntry>({
          name: idp.name,
          activeTokenCount: 1,
          lastSeenAt: idp.lastSeenAt,
        });
        assertEscaped(
          captureRaw(() =>
            createAccessGroupIdpRenderer("log").renderList([entry])
          ),
          [idp.name],
        );
      },
    ),
    RUNS,
  );
});

const delegationArb = fc.record({
  id: text,
  integrationId: text,
  state: text,
  username: nonEmpty,
  email: text,
  platform: text,
  teamId: text,
  userId: text.filter((u) => u.length > 0),
  display: text,
  workspace: text,
  ceilingDigest: text,
  createdAt: text,
  consentedAt: text,
  expiresAt: lastColumn,
  endedAt: text,
  endCause: text,
  refusalReason: text,
  linkId: text,
  lastEndError: text,
  nextEndAttemptAt: text,
  accessTokenExpiresAt: text,
  cause: text,
  since: text,
  mergedInto: text,
  retiredLinkId: text,
  retiredError: text,
});

type DelegationFields = typeof delegationArb extends fc.Arbitrary<infer T> ? T
  : never;

function delegationOf(d: DelegationFields): DelegationView {
  return cast<DelegationView>({
    id: d.id,
    integrationId: d.integrationId,
    state: d.state,
    person: { username: d.username, email: d.email },
    external: {
      platform: d.platform,
      teamId: d.teamId,
      userId: d.userId,
      display: d.display,
      workspace: d.workspace,
    },
    ceilingDigest: d.ceilingDigest,
    createdAt: d.createdAt,
    consentedAt: d.consentedAt,
    expiresAt: d.expiresAt,
    endedAt: d.endedAt,
    endCause: d.endCause,
    refusalReason: d.refusalReason,
    club: {
      linkId: d.linkId,
      endState: "pending",
      endAttempts: 2,
      lastEndError: d.lastEndError,
      nextEndAttemptAt: d.nextEndAttemptAt,
    },
    tokenGeneration: 3,
    accessTokenExpiresAt: d.accessTokenExpiresAt,
    hold: { causes: [d.cause], since: d.since },
    mergedInto: d.mergedInto,
    retiredLinks: [{
      linkId: d.retiredLinkId,
      endState: "pending",
      endAttempts: 1,
      lastEndError: d.retiredError,
    }],
  });
}

Deno.test("access delegation output: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(delegationArb, (d) => {
      const view = delegationOf(d);
      const single = [
        d.id,
        d.integrationId,
        d.state,
        `${d.username} <${d.email}>`,
        `${d.display} (${d.platform}:${d.userId})`,
        d.teamId,
        d.workspace,
        d.ceilingDigest,
        d.createdAt,
        d.consentedAt,
        d.expiresAt,
        d.endedAt,
        d.endCause,
        d.refusalReason,
        d.linkId,
        d.nextEndAttemptAt,
        d.accessTokenExpiresAt,
        d.since,
        d.mergedInto,
        d.retiredLinkId,
      ];
      assertEscaped(
        captureRaw(() => renderDelegation(view, "log")),
        single,
        [d.lastEndError, d.retiredError],
      );
      assertEscaped(
        captureRaw(() =>
          renderDelegationEnded(
            { delegation: view, alreadyEnded: false },
            "log",
          )
        ),
        [d.id],
      );
      assertEscaped(
        captureRaw(() =>
          renderDelegationEnded({ delegation: view, alreadyEnded: true }, "log")
        ),
        [d.id],
      );
      assertEscaped(
        captureRaw(() =>
          renderDelegationList({ delegations: [view], count: 1 }, "log")
        ),
        [
          d.id,
          d.integrationId,
          d.state,
          `${d.username} <${d.email}>`,
          `${d.display} (${d.platform}:${d.userId})`,
          d.expiresAt,
        ],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderDelegation(view, "json"))),
        view,
      );
    }),
    RUNS,
  );
});

const integrationArb = fc.record({
  id: text,
  name: text,
  state: text,
  pattern: text,
  ceilingDigest: text,
  createdAt: lastColumn,
  ceilingChangedAt: text,
  revokedAt: text,
  credential: text,
});

Deno.test("access integration output: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(integrationArb, (i) => {
      const view = cast<IntegrationView>({
        id: i.id,
        name: i.name,
        state: i.state,
        ceiling: {
          version: 1,
          ceiling: [{ actions: ["read"], resource: `workflow:${i.pattern}` }],
        },
        ceilingDigest: i.ceilingDigest,
        createdAt: i.createdAt,
        ceilingChangedAt: i.ceilingChangedAt,
        revokedAt: i.revokedAt,
      });
      const printed = [
        i.id,
        i.name,
        i.state,
        i.ceilingDigest,
        i.createdAt,
        i.ceilingChangedAt,
        i.revokedAt,
      ];
      assertEscaped(captureRaw(() => renderIntegration(view, "log")), printed);
      assertEscaped(
        captureRaw(() =>
          renderIntegrationRegistered(view, i.credential, "log")
        ),
        [...printed, i.credential],
      );
      assertEscaped(
        captureRaw(() => renderIntegrationRevoked(view, true, "log")),
        printed,
      );
      assertEscaped(
        captureRaw(() =>
          renderIntegrationList({ integrations: [view], count: 1 }, "log")
        ),
        [i.id, i.state, i.name, i.createdAt],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderIntegration(view, "json"))),
        view,
      );
    }),
    RUNS,
  );
});

const tokenArb = fc.record({
  name: text,
  principalId: text,
  expiresAt: text,
  vaultName: text,
  secretKey: text,
  revokedAt: text,
  token: text,
  effectiveState: text,
  lastUsedAt: lastColumn,
});

Deno.test("access token output: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(tokenArb, (t) => {
      const created = cast<ServerTokenCreateData>({
        name: t.name,
        principalId: t.principalId,
        expiresAt: t.expiresAt,
        vaultRef: { vaultName: t.vaultName, secretKey: t.secretKey },
      });
      const detail = [t.name, t.principalId, t.expiresAt, t.vaultName];
      assertEscaped(
        captureRaw(() => renderServerTokenCreate(created, "log")),
        [...detail, t.secretKey],
      );
      assertEscaped(
        captureRaw(() =>
          renderServerTokenRotate(cast<ServerTokenRotateData>(created), "log")
        ),
        [...detail, t.secretKey],
      );
      const list = cast<ServerTokenListData>({
        tokens: [{
          name: t.name,
          effectiveState: t.effectiveState,
          principalId: t.principalId,
          expiresAt: t.expiresAt,
          lastUsedAt: t.lastUsedAt,
        }],
      });
      assertEscaped(
        captureRaw(() => renderServerTokenList(list, "log")),
        [t.name, t.effectiveState, t.principalId, t.expiresAt, t.lastUsedAt],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderServerTokenList(list, "json"))),
        list.tokens,
      );
      assertEscaped(
        captureRaw(() =>
          renderServerTokenRevoke(
            cast<ServerTokenRevokeData>({
              name: t.name,
              alreadyRevoked: false,
              revokedAt: t.revokedAt,
            }),
            "log",
          )
        ),
        [t.name, t.revokedAt],
      );
      assertEscaped(
        captureRaw(() =>
          renderServerTokenRevoke(
            cast<ServerTokenRevokeData>({ name: t.name, alreadyRevoked: true }),
            "log",
          )
        ),
        [t.name],
      );
      assertEscaped(
        captureRaw(() =>
          renderServerTokenReveal(
            cast<ServerTokenRevealData>({
              name: t.name,
              token: t.token,
              expired: true,
            }),
            "log",
          )
        ),
        [t.name, t.token],
      );
    }),
    RUNS,
  );
});

Deno.test("audit timeline renderer: no recorded control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(short(1), short(3), (summary, error) => {
      const entry = cast<AuditEntry>({
        timestamp: "2026-11-27T12:00:00.000Z",
        source: "direct",
        summary,
        status: "error",
        exitCode: 1,
        error: error || "e",
      });
      assertEscaped(
        captureRaw(() =>
          createAuditTimelineRenderer("log").handlers().completed({
            kind: "completed",
            data: {
              status: "timeline",
              timeline: {
                entries: [entry],
                hoursAnalyzed: 1,
                totalSwamp: 0,
                totalDirect: 1,
              },
            },
          })
        ),
        [summary, error || "e"],
      );
    }),
    RUNS,
  );
});

Deno.test("audit outputs: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(
      fc.record({
        ruleName: text,
        description: text,
        ruleState: text,
        lastFiredAt: text,
        body: text,
        category: text,
        action: text,
        principalId: text,
        resourceKind: text,
        resourceName: text,
        client: lastColumn,
        cursor: text,
        name: text,
        from: text,
        to: text,
        generatedAt: text,
        markdown: text,
        message: text,
        brokenAt: text,
      }),
      (a) => {
        const alerts = cast<AuditAlertsResponse>({
          rules: [{
            name: a.ruleName,
            description: a.description,
            state: a.ruleState,
            windowCount: 2,
            lastFiredAt: a.lastFiredAt,
          }],
        });
        assertEscaped(
          captureRaw(() => renderAuditAlerts(alerts, "log")),
          [a.ruleName, a.description, a.ruleState, a.lastFiredAt],
        );
        assertEquals(
          JSON.parse(captureRaw(() => renderAuditAlerts(alerts, "json"))),
          alerts,
        );

        const exportOutput = (mode: "log" | "json") =>
          captureRaw(() =>
            createAuditExportRenderer(mode).handlers().completed({
              kind: "completed",
              data: { format: "csv", count: 1, data: a.body },
            })
          );
        assertEscaped(exportOutput("log"), [], [a.body]);
        assertEquals(JSON.parse(exportOutput("json")).data, a.body);

        const log = cast<AuditQueryResponse>({
          events: [{
            timestamp: "2026-11-27T12:00:00.000Z",
            outcome: "success",
            category: a.category,
            action: a.action,
            principalId: a.principalId,
            resourceKind: a.resourceKind,
            resourceName: a.resourceName,
            client: a.client,
          }],
          cursor: a.cursor,
          total: 9,
        });
        assertEscaped(captureRaw(() => renderAuditLog(log, "log")), [
          a.category,
          a.action,
          a.principalId,
          `${a.resourceKind}:${a.resourceName}`,
          a.client,
          a.cursor,
        ]);
        assertEquals(
          JSON.parse(captureRaw(() => renderAuditLog(log, "json"))),
          log,
        );

        const report = cast<AuditReportResponse>({
          name: a.name,
          description: a.description,
          from: a.from,
          to: a.to,
          generatedAt: a.generatedAt,
          markdown: a.markdown,
          data: {},
        });
        assertEscaped(
          captureRaw(() => renderAuditReport(report, "log")),
          [a.name, a.description, a.from, a.to, a.generatedAt],
          [a.markdown],
        );
        assertEquals(
          JSON.parse(captureRaw(() => renderAuditReport(report, "json"))),
          report,
        );

        const message = a.message || "m";
        for (const versions of [[0, 0], [1, 2]]) {
          assertEscaped(
            captureRaw(() =>
              renderAuditRotateKey(
                cast<AuditRotateKeyResponse>({
                  previousVersion: versions[0],
                  newVersion: versions[1],
                  message,
                }),
                "log",
              )
            ),
            [message],
          );
        }
        for (const valid of [true, false]) {
          assertEscaped(
            captureRaw(() =>
              renderAuditVerify(
                cast<AuditVerifyResponse>({
                  valid,
                  eventsChecked: 3,
                  brokenAt: a.brokenAt,
                  message,
                }),
                "log",
              )
            ),
            valid ? [message] : [message, a.brokenAt],
          );
        }
      },
    ),
    RUNS,
  );
});

Deno.test("renderServeCheckConfig: no provider-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(
      fc.record({
        provider: text,
        entry: text,
        sub: text,
        missing: text,
        collective: text,
        refusal: text,
        warning: text,
        routesDirError: text,
        routeError: text,
        file: text,
        grantError: text,
        grantWarning: text,
        vault: text,
        key: text,
        keyError: text,
      }),
      (c) => {
        const data = cast<ServeCheckConfigData>({
          passed: false,
          authMode: "oauth",
          oauthProvider: c.provider,
          entries: [
            {
              kind: "admin",
              entry: c.entry,
              username: c.entry,
              status: "resolved",
              sub: c.sub,
            },
            {
              kind: "allowed-user",
              entry: c.missing,
              username: c.missing,
              status: "not-found",
            },
          ],
          allowedCollectives: [c.collective],
          wouldStart: false,
          refusal: c.refusal,
          personalCollectiveWarnings: [{ message: c.warning }],
          adminWarnings: [{ message: c.warning }],
          restrictionWarnings: [{ message: c.warning }],
          webhookWarnings: [{ message: c.warning }],
          webhookRouteFileErrors: [{ file: c.file, message: c.routeError }],
          webhookRoutesDirError: c.routesDirError,
          grantErrors: [{ file: c.file, message: c.grantError }],
          grantWarnings: [{ file: c.file, entry: 2, message: c.grantWarning }],
          grantFilesChecked: 1,
          tokenSecretsKey: {
            vault: c.vault,
            key: c.key,
            status: "failed",
            error: c.keyError,
          },
        });
        assertEscaped(captureRaw(() => renderServeCheckConfig(data, "log")), [
          c.provider,
          c.entry,
          c.sub,
          c.missing,
          c.collective,
          c.refusal,
          c.warning,
          c.routesDirError,
          c.routeError,
          c.file,
          `${c.file} entry 2`,
          c.grantError,
          c.grantWarning,
          c.vault,
          c.key,
          c.keyError,
        ]);
        assertEquals(
          JSON.parse(captureRaw(() => renderServeCheckConfig(data, "json"))),
          data,
        );
      },
    ),
    RUNS,
  );
});
