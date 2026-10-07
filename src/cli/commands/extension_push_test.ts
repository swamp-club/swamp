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

import { assertEquals } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import {
  REGISTRY_FORBIDDEN_CODE,
  REGISTRY_NOT_AUTHENTICATED_MESSAGE,
  REGISTRY_TOKEN_SCOPE_CODE,
} from "../../infrastructure/http/extension_api_client.ts";
import type { ExtensionPushPrepareDeps } from "../../libswamp/extensions/push.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import type { WarningsWaiver } from "../../presentation/renderers/extension_push.ts";
import {
  buildAcceptedWarnings,
  lookupPublishedBaseline,
  resolveExistingVersionResponse,
  resolveWarningsGate,
  resolveWarningsWaiver,
} from "./extension_push.ts";

function gate(overrides: {
  warningCount?: number;
  waiver?: WarningsWaiver;
  dryRun?: boolean;
  outputMode?: OutputMode;
}) {
  return resolveWarningsGate({
    warningCount: 1,
    waiver: undefined,
    dryRun: false,
    outputMode: "log",
    ...overrides,
  });
}

Deno.test("resolveWarningsWaiver: --yes waives, --force waives, --yes wins when both are passed", () => {
  assertEquals(resolveWarningsWaiver({ yes: true }), "--yes");
  assertEquals(resolveWarningsWaiver({ force: true }), "--force");
  assertEquals(resolveWarningsWaiver({ yes: true, force: true }), "--yes");
  assertEquals(resolveWarningsWaiver({}), undefined);
  assertEquals(resolveWarningsWaiver({ yes: false, force: false }), undefined);
});

Deno.test("resolveWarningsGate: --yes and --force proceed and record the flag in every mode", () => {
  for (const waiver of ["--yes", "--force"] as const) {
    for (const outputMode of ["log", "json"] as const) {
      for (const dryRun of [true, false]) {
        assertEquals(
          gate({ waiver, outputMode, dryRun, warningCount: 3 }),
          { kind: "proceed", waivedBy: waiver },
          `${waiver} ${outputMode} dryRun=${dryRun}`,
        );
      }
    }
  }
});

Deno.test("resolveWarningsGate: json push with a warning and no flag proceeds without a record", () => {
  // The pre-#3015 behaviour: --json never prompted and never refused. The
  // warnings were rendered ahead of the gate, so nothing is hidden.
  assertEquals(gate({ outputMode: "json" }), { kind: "proceed" });
});

Deno.test("resolveWarningsGate: json dry run with a warning and no flag proceeds without a record", () => {
  assertEquals(
    gate({ outputMode: "json", dryRun: true }),
    { kind: "proceed" },
  );
});

Deno.test("resolveWarningsGate: log dry run with a warning and no flag proceeds without prompting", () => {
  // A dry run performs no push and so has nothing to confirm.
  assertEquals(gate({ dryRun: true }), { kind: "proceed" });
});

Deno.test("resolveWarningsGate: log push with a warning and no flag prompts", () => {
  // The prompt helper itself rejects a non-terminal stdin and names --yes, so
  // the gate does not need to know whether a terminal is attached.
  assertEquals(gate({}), { kind: "prompt" });
});

Deno.test("resolveWarningsGate: no warnings proceeds without a record in every mode", () => {
  for (const waiver of ["--yes", "--force", undefined] as const) {
    for (const outputMode of ["log", "json"] as const) {
      for (const dryRun of [true, false]) {
        assertEquals(
          gate({ warningCount: 0, waiver, outputMode, dryRun }),
          { kind: "proceed" },
          `${waiver} ${outputMode} dryRun=${dryRun}`,
        );
      }
    }
  }
});

Deno.test("buildAcceptedWarnings: keeps safety warnings and drops the review skeleton and every remediation", () => {
  const record = buildAcceptedWarnings({
    safetyWarnings: [{
      ruleId: "deno-command",
      file: "models/a.ts",
      line: 7,
      message: "uses Deno.Command",
      remediation: "prefer swamp primitives",
    }],
    reviewRulesResult: {
      warnings: [
        {
          ruleId: "adversarial-review-report",
          dimension: "review",
          severity: "high",
          file: "manifest.yaml",
          message: "No adversarial review recorded",
          remediation: "run the review",
          skeleton: {
            extension: "@test/ext",
            version: "1",
            reviewedAt: "<ISO-8601 timestamp>",
            dimensions: [],
          },
        },
        {
          ruleId: "bare-specifiers",
          dimension: "scoring",
          severity: "medium",
          file: "(multiple files)",
          message: "Extension uses bare import specifiers",
        },
      ],
    },
  });
  assertEquals(record, {
    safety: [{
      ruleId: "deno-command",
      file: "models/a.ts",
      line: 7,
      message: "uses Deno.Command",
    }],
    review: [
      {
        ruleId: "adversarial-review-report",
        dimension: "review",
        severity: "high",
        file: "manifest.yaml",
        message: "No adversarial review recorded",
      },
      {
        ruleId: "bare-specifiers",
        dimension: "scoring",
        severity: "medium",
        file: "(multiple files)",
        message: "Extension uses bare import specifiers",
      },
    ],
  });
  assertEquals("skeleton" in record.review[0], false);
});

// ── Existing version (swamp-club#2939) ────────────────────────────────

const LOWER_CHANNEL_MESSAGE =
  "Version 2026.10.06.1 already exists for @x/y on channel 'beta'. " +
  "To move it to 'stable' without re-publishing, run: " +
  "swamp extension promote @x/y 2026.10.06.1 --channel stable";

function existing(overrides: {
  existingChannel?: string;
  requestedChannel?: string;
  checkMessage?: string;
  outputMode?: OutputMode;
  yes?: boolean;
  force?: boolean;
}) {
  return resolveExistingVersionResponse({
    extensionName: "@x/y",
    version: "2026.10.06.1",
    checkMessage: "Version 2026.10.06.1 already exists for @x/y.",
    existingChannel: "stable",
    requestedChannel: "stable",
    outputMode: "log",
    ...overrides,
  });
}

const SAME_CHANNEL_REFUSAL = "Version 2026.10.06.1 already exists for @x/y. " +
  "Use a different version or let the CLI bump it interactively.";

Deno.test("resolveExistingVersionResponse: interactive, a lower channel offers the three-way choice", () => {
  assertEquals(
    existing({ existingChannel: "beta", requestedChannel: "stable" }),
    { kind: "choose" },
  );
  assertEquals(
    existing({ existingChannel: "beta", requestedChannel: "rc" }),
    { kind: "choose" },
  );
});

Deno.test("resolveExistingVersionResponse: interactive, the same or a higher channel asks to bump", () => {
  assertEquals(existing({}), { kind: "bump-prompt" });
  assertEquals(
    existing({ existingChannel: "stable", requestedChannel: "beta" }),
    { kind: "bump-prompt" },
  );
});

Deno.test("resolveExistingVersionResponse: --yes and --force never promote", () => {
  for (const flags of [{ yes: true }, { force: true }]) {
    assertEquals(
      existing({
        existingChannel: "beta",
        requestedChannel: "stable",
        checkMessage: LOWER_CHANNEL_MESSAGE,
        ...flags,
      }),
      { kind: "refuse", message: LOWER_CHANNEL_MESSAGE },
    );
  }
});

Deno.test("resolveExistingVersionResponse: --json refuses a same-channel duplicate with the pre-#2939 message", () => {
  assertEquals(existing({ outputMode: "json" }), {
    kind: "refuse",
    message: SAME_CHANNEL_REFUSAL,
  });
  assertEquals(existing({ yes: true }), {
    kind: "refuse",
    message: SAME_CHANNEL_REFUSAL,
  });
});

Deno.test("resolveExistingVersionResponse: --json on another channel refuses with the channel-aware message", () => {
  assertEquals(
    existing({
      existingChannel: "beta",
      requestedChannel: "stable",
      checkMessage: LOWER_CHANNEL_MESSAGE,
      outputMode: "json",
    }),
    { kind: "refuse", message: LOWER_CHANNEL_MESSAGE },
  );
});

type BaselineDeps = Pick<
  ExtensionPushPrepareDeps,
  "loadCredentials" | "getLatestVersionDetail"
>;

const SIGNED_IN: BaselineDeps["loadCredentials"] = () =>
  Promise.resolve({
    serverUrl: "https://registry.example",
    apiKey: "key",
    username: "alice",
  });

Deno.test("lookupPublishedBaseline: no credentials is no-credentials, and the registry is not called", async () => {
  let called = false;
  const result = await lookupPublishedBaseline({
    loadCredentials: () => Promise.resolve(null),
    getLatestVersionDetail: () => {
      called = true;
      return Promise.resolve(null);
    },
  }, "@alice/ext");
  assertEquals(result, { kind: "no-credentials" });
  assertEquals(called, false);
});

Deno.test("lookupPublishedBaseline: no version in the registry is never-published", async () => {
  const result = await lookupPublishedBaseline({
    loadCredentials: SIGNED_IN,
    getLatestVersionDetail: () => Promise.resolve(null),
  }, "@alice/ext");
  assertEquals(result, { kind: "never-published" });
});

Deno.test("lookupPublishedBaseline: a published version maps to its model versions", async () => {
  const asked: string[] = [];
  const result = await lookupPublishedBaseline({
    loadCredentials: SIGNED_IN,
    getLatestVersionDetail: (serverUrl, name, apiKey) => {
      asked.push(serverUrl, name, apiKey);
      return Promise.resolve({
        version: "2026.09.28.1",
        publishedAt: "",
        contentMetadata: {
          models: [{
            fileName: "ssh.ts",
            type: "@alice/ssh",
            version: "2026.09.20.1",
            globalArguments: [],
            methods: [],
            resources: [],
            files: [],
          }],
          extensions: [],
          workflows: [],
          vaults: [],
          datastores: [],
          reports: [],
          webhooks: [],
          skills: [],
        },
      });
    },
  }, "@alice/ext");
  assertEquals(asked, ["https://registry.example", "@alice/ext", "key"]);
  assertEquals(result, {
    kind: "found",
    state: {
      manifestVersion: "2026.09.28.1",
      models: [{ fileName: "ssh.ts", version: "2026.09.20.1" }],
    },
  });
});

Deno.test("lookupPublishedBaseline: a version without content metadata has no models", async () => {
  const result = await lookupPublishedBaseline({
    loadCredentials: SIGNED_IN,
    getLatestVersionDetail: () =>
      Promise.resolve({
        version: "2026.09.28.1",
        publishedAt: "",
        contentMetadata: null,
      }),
  }, "@alice/ext");
  assertEquals(result, {
    kind: "found",
    state: { manifestVersion: "2026.09.28.1", models: [] },
  });
});

Deno.test("lookupPublishedBaseline: an unreachable registry is registry-unavailable with its message", async () => {
  const result = await lookupPublishedBaseline({
    loadCredentials: SIGNED_IN,
    getLatestVersionDetail: () =>
      Promise.reject(
        new Error(
          "Could not connect to https://registry.example: fetch failed",
        ),
      ),
  }, "@alice/ext");
  assertEquals(result, {
    kind: "registry-unavailable",
    reason: "Could not connect to https://registry.example: fetch failed",
  });
});

Deno.test("lookupPublishedBaseline: failing to load credentials is registry-unavailable, not no-credentials", async () => {
  const result = await lookupPublishedBaseline({
    loadCredentials: () => Promise.reject(new Error("auth.json is corrupt")),
    getLatestVersionDetail: () => Promise.resolve(null),
  }, "@alice/ext");
  assertEquals(result, {
    kind: "registry-unavailable",
    reason: "auth.json is corrupt",
  });
});

Deno.test("lookupPublishedBaseline: an HTTP 500 is registry-unavailable with the status in the reason", async () => {
  const message =
    "Extension API error (HTTP 500): boom [https://registry.example/api/v1/extensions/%40alice%2Fext/latest]";
  const result = await lookupPublishedBaseline({
    loadCredentials: SIGNED_IN,
    getLatestVersionDetail: () => Promise.reject(new UserError(message)),
  }, "@alice/ext");
  assertEquals(result, { kind: "registry-unavailable", reason: message });
});

Deno.test("lookupPublishedBaseline: a 401 or 403 from the registry is authentication-failed", async () => {
  for (
    const error of [
      new UserError(REGISTRY_NOT_AUTHENTICATED_MESSAGE),
      new UserError("Forbidden", REGISTRY_FORBIDDEN_CODE),
      new UserError("Token lacks required scope", REGISTRY_TOKEN_SCOPE_CODE),
    ]
  ) {
    const result = await lookupPublishedBaseline({
      loadCredentials: SIGNED_IN,
      getLatestVersionDetail: () => Promise.reject(error),
    }, "@alice/ext");
    assertEquals(result, {
      kind: "authentication-failed",
      reason: error.message,
    });
  }
});
