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
import type { GenesisPass } from "../../domain/quest/genesis_pass.ts";
import { createIssueGetRenderer } from "../renderers/issue_get.ts";
import { createIssueSearchRenderer } from "../renderers/issue_search.ts";
import { createAuthLoginRenderer } from "../renderers/auth_login.ts";
import { createAuthWhoamiRenderer } from "../renderers/auth_whoami.ts";
import { createSubscriptionStatusRenderer } from "../renderers/subscription_status.ts";
import { createInviteLinkRenderer } from "../renderers/invite_link.ts";
import { createQuestPassRenderer } from "../renderers/quest_pass.ts";
import { createStartRenderer } from "../renderers/start.ts";
import { createTrustListRenderer } from "../renderers/trust_list.ts";
import { createAuthLogoutRenderer } from "../renderers/auth_logout.ts";
import {
  renderAuthTokenCreate,
  renderAuthTokenList,
} from "./auth_token_output.ts";
import { renderAuthOAuthClientRegister } from "./auth_oauth_client_output.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const text = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
    fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;title\x07"),
    fc.fullUnicode(),
  ),
});

const RUNS = { numRuns: 50 };

/** stdout and stderr, colour codes left in */
function captureBoth(render: () => void): string {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => lines.push(String(message ?? ""));
  try {
    lines.push(captureRaw(render));
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

// multi-line remote text keeps its tabs on purpose
function assertEscaped(
  output: string,
  single: readonly string[],
  multi: readonly string[] = [],
): void {
  assertNoControlCharacters(
    multi.length > 0 ? output.replaceAll("\t", "") : output,
  );
  for (const value of single) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
  for (const value of multi) {
    const escaped = escapeControlCharactersInText(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

const issueArb = fc.record({
  title: text,
  type: text,
  status: text,
  author: text,
  assignee: text,
  commentAuthor: text,
  commentCreatedAt: text.filter((t) => t.length > 0),
  url: text,
});

Deno.test("createIssueGetRenderer and createIssueSearchRenderer: no swamp-club control character reaches the terminal, and JSON output is the input exactly", () => {
  fc.assert(
    fc.property(issueArb, (i) => {
      const data = {
        number: 7,
        title: i.title,
        type: i.type,
        status: i.status,
        author: i.author,
        body: "",
        assignees: [i.assignee],
        createdAt: "",
        updatedAt: "",
        commentCount: 1,
        comments: [{
          author: i.commentAuthor,
          body: "",
          createdAt: i.commentCreatedAt,
        }],
        url: i.url,
      };
      assertEscaped(
        captureRaw(() =>
          createIssueGetRenderer("log", true).handlers().completed({
            kind: "completed",
            data,
          })
        ),
        [
          i.title,
          i.type,
          i.status,
          i.author,
          i.assignee,
          i.commentAuthor,
          i.commentCreatedAt,
          i.url,
        ],
      );
      assertEquals(
        JSON.parse(
          captureRaw(() =>
            createIssueGetRenderer("json").handlers().completed({
              kind: "completed",
              data,
            })
          ),
        ),
        data,
      );

      const item = {
        number: 7,
        title: i.title,
        type: i.type,
        status: i.status,
        author: i.author,
        createdAt: "",
        updatedAt: "",
        url: i.url,
      };
      const title = escapeControlCharacters(i.title);
      const search = captureRaw(() =>
        createIssueSearchRenderer("log").handlers().completed({
          kind: "completed",
          data: { issues: [item], total: 1 },
        })
      );
      assertEscaped(search, [i.type, i.status, i.author]);
      // the title is cut to the column
      assert(search.includes(title.length <= 60 ? title : title.slice(0, 59)));
    }),
    RUNS,
  );
});

const accountArb = fc.record({
  userCode: text,
  verificationUri: text,
  username: text,
  name: text,
  email: text,
  apiKey: text,
  collectiveSlug: text,
  scope: text,
  planName: text,
  status: text,
  collective: text,
});

Deno.test("createAuthLoginRenderer, createAuthWhoamiRenderer and createSubscriptionStatusRenderer: no account field from swamp-club reaches the terminal raw", () => {
  fc.assert(
    fc.property(accountArb, (a) => {
      const login = createAuthLoginRenderer("log", false, {
        isFirstLogin: false,
        isInteractive: false,
      }).handlers();
      assertEscaped(
        captureRaw(() => {
          login.device_verification({
            kind: "device_verification",
            userCode: a.userCode,
            verificationUri: a.verificationUri,
          });
          login.completed({
            kind: "completed",
            data: {
              username: a.username,
              name: a.name,
              email: a.email,
              serverUrl: "https://swamp.club",
              apiKey: a.apiKey,
            },
          });
        }),
        [a.userCode, a.verificationUri, a.username, a.name, a.email],
      );

      const entitlement = {
        slug: a.collectiveSlug,
        plan: "team",
        planName: a.planName,
        subscriptionStatus: a.status,
      };
      const whoami = createAuthWhoamiRenderer("log").handlers();
      assertEscaped(
        captureRaw(() => {
          whoami.completed({
            kind: "completed",
            identity: {
              serverUrl: "https://swamp.club",
              id: "u1",
              username: a.username,
              email: a.email,
              name: a.name,
              plan: "team",
              collectiveEntitlements: [entitlement],
            },
          });
          whoami.completed({
            kind: "completed",
            identity: {
              serverUrl: "https://swamp.club",
              id: "u1",
              username: a.username,
              email: a.email,
              name: a.name,
              collectives: [a.collective],
              collectiveToken: true,
              collectiveSlug: a.collectiveSlug,
              scopes: [a.scope],
            },
          });
        }),
        [
          a.username,
          a.email,
          a.collectiveSlug,
          a.planName,
          a.status,
          a.scope,
          a.collective,
        ],
      );

      assertEscaped(
        captureRaw(() =>
          createSubscriptionStatusRenderer("log").handlers().completed({
            kind: "completed",
            status: {
              serverUrl: "https://swamp.club",
              collectiveToken: false,
              username: a.username,
              email: a.email,
              plan: "team",
              planName: a.planName,
              entitlementsReported: true,
              collectives: [entitlement],
              billingUrl: "https://swamp.club/billing",
            },
          })
        ),
        [a.username, a.email, a.planName, a.collectiveSlug, a.status],
      );
    }),
    RUNS,
  );
});

const miscArb = fc.record({
  url: text,
  challenge: text,
  tier: text,
  username: text,
  reason: text.filter((t) => t.length > 0),
  explicit: text,
  membership: text,
  resolved: text,
});

function passOf(challenge: string, tier: string): GenesisPass {
  return {
    campaign: "genesis",
    username: "u",
    passXp: 10,
    currentTier: 1,
    totalTiers: 5,
    hasPremium: false,
    canClaim: false,
    claimableTier: null,
    nextTier: { n: 2, name: tier, cumXp: 100, premiumName: "" },
    xpIntoCurrent: 10,
    xpForNext: 100,
    toNext: 90,
    ladderFraction: 0.1,
    tiers: [],
    challenges: [{
      id: "c1",
      name: challenge,
      verb: "",
      xp: 50,
      kind: "first",
      target: null,
      bridge: false,
      category: { key: "k", label: "l", color: "c" },
      progress: 0,
      done: false,
    }],
  };
}

Deno.test("invite, quest, start, trust and logout renderers: no swamp-club control character reaches the terminal, and JSON output is the input exactly", () => {
  fc.assert(
    fc.property(miscArb, (m) => {
      assertEscaped(
        captureBoth(() =>
          createInviteLinkRenderer("log").handlers().completed({
            kind: "completed",
            data: { code: "c", url: m.url },
          })
        ),
        [m.url],
      );
      assertEquals(
        JSON.parse(
          captureRaw(() =>
            createInviteLinkRenderer("json").handlers().completed({
              kind: "completed",
              data: { code: "c", url: m.url },
            })
          ),
        ),
        { code: "c", url: m.url },
      );

      const pass = passOf(m.challenge, m.tier);
      assertEscaped(
        captureRaw(() =>
          createQuestPassRenderer("log", true).handlers().completed({
            kind: "completed",
            data: { pass, ghost: false },
          })
        ),
        [m.challenge, m.tier],
      );
      assertEquals(
        JSON.parse(
          captureRaw(() =>
            createQuestPassRenderer("json").handlers().completed({
              kind: "completed",
              data: { pass, ghost: false },
            })
          ),
        ),
        pass,
      );

      const start = createStartRenderer("log");
      const startOutput = captureRaw(() => {
        start.prepareHandlers().signed_in_checked({
          kind: "signed_in_checked",
          state: { kind: "signed_in", username: m.username, source: "file" },
        });
        start.inspection({
          signedIn: "blocked",
          blockedReason: m.reason,
          workspaces: [],
          agents: [],
        });
      });
      assertEscaped(startOutput, [m.username]);
      assertNoControlCharacters(startOutput.replaceAll("\t", ""));
      // the reason prints indented under its heading
      const indented = escapeControlCharactersInText(m.reason).split("\n")
        .map((line) => `    ${line}`).join("\n");
      assert(
        startOutput.includes(indented),
        `${JSON.stringify(indented)} missing`,
      );

      const trust = {
        explicit: [m.explicit],
        membership: [m.membership],
        resolved: [m.resolved],
        trustMemberCollectives: true,
      };
      assertEscaped(
        captureRaw(() =>
          createTrustListRenderer("log").handlers().completed({
            kind: "completed",
            data: trust,
          })
        ),
        [m.explicit, m.membership, m.resolved],
      );

      assertEscaped(
        captureRaw(() =>
          createAuthLogoutRenderer("log").handlers().completed({
            kind: "completed",
            data: {
              loggedOut: true,
              username: m.username,
              serverUrl: "https://swamp.club",
            },
          })
        ),
        [m.username],
      );
    }),
    RUNS,
  );
});

const tokenArb = fc.record({
  name: text,
  id: text,
  keyPrefix: text,
  fingerprint: text,
  scope: text,
  createdAt: text,
  // the list trims trailing whitespace off the last column
  lastUsedAt: text.filter((t) => t.trimEnd() === t && t.length > 0),
  expiresAt: text,
  mintedBy: text.filter((t) => t.length > 0),
  key: text,
  signinToken: text.filter((t) => t.length > 0),
  clientId: text,
  clientSecret: text,
});

Deno.test("renderAuthTokenCreate, renderAuthTokenList and renderAuthOAuthClientRegister: no swamp-club control character reaches the terminal, and JSON output is the input exactly", () => {
  fc.assert(
    fc.property(tokenArb, (t) => {
      const created = {
        key: t.key,
        fingerprint: t.fingerprint,
        id: t.id,
        name: t.name,
        collective: "c",
        scopes: [t.scope],
        expiresAt: t.expiresAt,
        mintedByTokenId: t.mintedBy,
        signinToken: t.signinToken,
      };
      assertEscaped(
        captureRaw(() => renderAuthTokenCreate(created, "log")),
        [
          t.name,
          t.scope,
          t.expiresAt,
          t.mintedBy,
          t.fingerprint,
          t.key,
          t.signinToken,
        ],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderAuthTokenCreate(created, "json"))),
        created,
      );

      const listed = {
        collective: "c",
        moreInactive: false,
        tokens: [{
          id: t.id,
          name: t.name,
          keyPrefix: t.keyPrefix,
          enabled: true,
          expiresAt: null,
          createdAt: t.createdAt,
          lastUsedAt: t.lastUsedAt,
          scopes: [t.scope],
          mintedByTokenId: null,
          status: "active" as const,
        }],
      };
      assertEscaped(
        captureRaw(() => renderAuthTokenList(listed, "log")),
        [t.name, t.id, t.keyPrefix, t.scope, t.createdAt, t.lastUsedAt],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderAuthTokenList(listed, "json"))),
        listed.tokens,
      );

      const client = {
        clientId: t.clientId,
        clientName: t.name,
        clientSecret: t.clientSecret,
        provider: "https://swamp.club",
      };
      assertEscaped(
        captureRaw(() => renderAuthOAuthClientRegister(client, "log")),
        [t.clientId, t.clientSecret, t.name],
      );
      assertEquals(
        JSON.parse(
          captureRaw(() => renderAuthOAuthClientRegister(client, "json")),
        ),
        client,
      );
    }),
    RUNS,
  );
});
