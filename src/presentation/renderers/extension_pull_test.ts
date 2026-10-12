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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createExtensionPullRenderer } from "./extension_pull.ts";
import { ExtensionReplacement } from "../../domain/extensions/extension_replacement.ts";
import type { InstallResult } from "../../libswamp/extensions/pull.ts";

await initializeLogging({});

/** Captures everything written through console.log/info/warn. */
function captureConsole(fn: () => void): string {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
  }
  return lines.join("\n");
}

const FILE = ".swamp/pulled-extensions/@test/ext/models/a.ts";
const SKILL = ".claude/skills/foo";

Deno.test("createExtensionPullRenderer: log mode lists skill dirs apart from overwritten files", () => {
  const renderer = createExtensionPullRenderer("log");
  const out = captureConsole(() => {
    renderer.renderConflicts([FILE, SKILL], [SKILL]);
  });
  assertStringIncludes(out, "already exist and will be overwritten");
  assertStringIncludes(out, "skill directories already exist");
  assertStringIncludes(out, "other files are kept");
  const overwriteSection = out.split("skill directories")[0];
  assertStringIncludes(overwriteSection, FILE);
  assert(!overwriteSection.includes(SKILL));
});

Deno.test("createExtensionPullRenderer: log mode without skill dirs prints only the file list", () => {
  const renderer = createExtensionPullRenderer("log");
  const out = captureConsole(() => {
    renderer.renderConflicts([FILE]);
  });
  assertStringIncludes(out, FILE);
  assert(!out.includes("skill directories"));
});

Deno.test("createExtensionPullRenderer: json mode adds skillDirs only when present", () => {
  const renderer = createExtensionPullRenderer("json");
  const withSkills = JSON.parse(captureConsole(() => {
    renderer.renderConflicts([FILE, SKILL], [SKILL]);
  }));
  assertEquals(withSkills, { conflicts: [FILE, SKILL], skillDirs: [SKILL] });
  const withoutSkills = JSON.parse(captureConsole(() => {
    renderer.renderConflicts([FILE]);
  }));
  assertEquals(withoutSkills, { conflicts: [FILE] });
});

const REPLACEMENT = ExtensionReplacement.create({
  name: "@test/ext",
  current: {
    version: "2026.09.23.1",
    channel: "stable",
    publishedChannel: "stable",
  },
  incoming: {
    version: "2026.10.01.1",
    channel: "stable",
    publishedChannel: "beta",
  },
});

Deno.test("createExtensionPullRenderer: log mode names the extension and the change before the file list", () => {
  const renderer = createExtensionPullRenderer("log");
  const out = captureConsole(() => {
    renderer.renderConflicts([FILE], [], REPLACEMENT);
  });
  const headline =
    "@test/ext: installed 2026.09.23.1 (stable) -> incoming 2026.10.01.1 (beta, following stable)";
  assertStringIncludes(out, headline);
  assertStringIncludes(
    out,
    "Upgrade: 2026.10.01.1 is newer than the installed 2026.09.23.1. Channel change: stable to beta.",
  );
  assert(out.indexOf(headline) < out.indexOf(FILE));
});

Deno.test("createExtensionPullRenderer: log mode states a replacement and an unopted pre-release", () => {
  const renderer = createExtensionPullRenderer("log");
  const out = captureConsole(() => {
    renderer.renderReplacement(REPLACEMENT);
    renderer.renderUnoptedPrerelease({
      name: "@test/ext",
      version: "2026.10.01.1",
      publishedChannel: "beta",
      parent: null,
    });
  });
  assertStringIncludes(
    out,
    "-> incoming 2026.10.01.1 (beta, following stable)",
  );
  assertStringIncludes(
    out,
    "@test/ext@2026.10.01.1 is a beta release, and --channel was not passed",
  );
});

Deno.test("createExtensionPullRenderer: json mode puts the replacement on the conflict document", () => {
  const renderer = createExtensionPullRenderer("json");
  const doc = JSON.parse(captureConsole(() => {
    renderer.renderConflicts([FILE], [], REPLACEMENT);
  }));
  assertEquals(doc, {
    name: "@test/ext",
    current: {
      version: "2026.09.23.1",
      channel: "stable",
      publishedChannel: "stable",
    },
    incoming: {
      version: "2026.10.01.1",
      channel: "stable",
      publishedChannel: "beta",
    },
    change: "upgrade",
    channelChanged: true,
    conflicts: [FILE],
  });
});

Deno.test("createExtensionPullRenderer: json mode prints nothing for a replacement or a pre-release notice", () => {
  const renderer = createExtensionPullRenderer("json");
  const out = captureConsole(() => {
    renderer.renderReplacement(REPLACEMENT);
    renderer.renderUnoptedPrerelease({
      name: "@test/ext",
      version: "2026.10.01.1",
      publishedChannel: "beta",
      parent: null,
    });
  });
  assertEquals(out, "");
});

function installResult(overrides: Partial<InstallResult>): InstallResult {
  return {
    name: "@test/ext",
    version: "2026.10.01.1",
    description: undefined,
    extractedFiles: [],
    integrityStatus: "verified",
    repository: undefined,
    platforms: [],
    safetyWarnings: [],
    binaries: [],
    conflicts: [],
    missingSourceFiles: [],
    hasSkills: false,
    hasSkillScripts: false,
    skillFiles: [],
    dependencies: [],
    dependencyResults: [],
    extendsTypes: [],
    pruned: [],
    createdPaths: [],
    ...overrides,
  };
}

async function firstJsonDocument(result: InstallResult): Promise<unknown> {
  const renderer = createExtensionPullRenderer("json");
  const docs: string[] = [];
  const original = console.log;
  console.log = (msg: string) => docs.push(msg);
  try {
    await renderer.handlers().completed({ kind: "completed", data: result });
  } finally {
    console.log = original;
  }
  return JSON.parse(docs[0]);
}

Deno.test("createExtensionPullRenderer: json mode reports what an install replaced", async () => {
  assertEquals(
    await firstJsonDocument(installResult({
      channel: "stable",
      publishedChannel: "beta",
      previous: REPLACEMENT.current,
      change: "upgrade",
      channelChanged: true,
    })),
    {
      name: "@test/ext",
      version: "2026.10.01.1",
      channel: "stable",
      publishedChannel: "beta",
      previous: {
        version: "2026.09.23.1",
        channel: "stable",
        publishedChannel: "stable",
      },
      change: "upgrade",
      channelChanged: true,
    },
  );
});

Deno.test("createExtensionPullRenderer: json mode reports a first install with previous null and no change", async () => {
  assertEquals(
    await firstJsonDocument(installResult({
      channel: "stable",
      publishedChannel: "stable",
      previous: null,
    })),
    {
      name: "@test/ext",
      version: "2026.10.01.1",
      channel: "stable",
      publishedChannel: "stable",
      previous: null,
    },
  );
});
