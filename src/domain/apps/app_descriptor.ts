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

import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { isAppReadCapability } from "@swamp-club/app-sdk/capabilities";
import { BRIDGE_VERSION } from "@swamp-club/app-sdk/bridge";
import { markErrorPaths, UserError } from "../errors.ts";
import { PlatformFieldSchema } from "./app_platform.ts";

export const APP_DESCRIPTOR_FILE = "app.yaml";

/** Where a repo keeps the apps it builds, beside its other extension kinds. */
export const APP_SOURCE_DIR = "extensions/apps";

const APP_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

// a name is hex-encoded into one filename, which most filesystems cap at 255
export const AppNameSchema = z.string().max(100).regex(
  APP_NAME_PATTERN,
  "An app name looks like @collective/name",
);

// the entry's folder is what serve answers for, so it must sit below the app
const safeEntry = z.string().min(1).max(500).refine(
  (path) =>
    !path.startsWith("/") && !path.includes("\\") && path.includes("/") &&
    !path.split("/").some((part) =>
      part === ".." || part === "." || part === ""
    ),
  "entry must be a path inside a build folder in the app",
);

const methodName = z.string().min(1).max(200);

// one type per behavior, so the broker always knows which type to pin; the
// method names are the grant, so any other method of the behavior is refused
const MethodGrantSchema = z.strictObject({
  behavior: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  type: z.string().min(1).max(200),
  methods: z.array(methodName).max(50).optional(),
}).superRefine((entry, ctx) => {
  if (entry.behavior !== undefined && entry.model !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "name the behavior under behavior: or model:, not both",
    });
  } else if (entry.behavior === undefined && entry.model === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["behavior"],
      message: "each entry names its behavior under behavior:",
    });
  }
  if (entry.methods === undefined || entry.methods.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["methods"],
      message:
        "each entry lists the methods the app may run, e.g. methods: [move_ticket]",
    });
  } else if (new Set(entry.methods).size !== entry.methods.length) {
    ctx.addIssue({
      code: "custom",
      path: ["methods"],
      message: "lists a method more than once",
    });
  }
}).transform((entry) => ({
  behavior: entry.behavior ?? entry.model ?? "",
  type: entry.type,
  methods: entry.methods ?? [],
}));

export const AppDescriptorSchema = z.strictObject({
  name: AppNameSchema,
  title: z.string().min(1).max(100),
  entry: safeEntry.default("dist/index.html"),
  bridge: z.literal(BRIDGE_VERSION),
  // left out of the capability key, so a platform bump never sends an app back for approval
  platform: PlatformFieldSchema.default(1),
  capabilities: z.array(
    z.string().refine(isAppReadCapability, "Unknown capability"),
  ).max(20).default([]),
  run: z.array(z.string().min(1).max(200)).max(50).default([]),
  methods: z.array(MethodGrantSchema).max(50).default([]).refine(
    (methods) =>
      new Set(methods.map((m) => m.behavior)).size === methods.length,
    "methods lists a behavior more than once",
  ),
});

export type AppDescriptor = z.infer<typeof AppDescriptorSchema>;

export function parseAppDescriptor(
  text: string,
  source: string,
): AppDescriptor {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw markErrorPaths(
      new UserError(
        `${source} is not valid YAML: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
      [source],
    );
  }
  const parsed = AppDescriptorSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw markErrorPaths(
      new UserError(
        `${source}: ${issue.path.join(".") || "app"}: ${issue.message}`,
      ),
      [source],
    );
  }
  return parsed.data;
}

/** Reordering a list never sends an app back for review; a new origin does. */
export function capabilityKey(
  descriptor: {
    readonly capabilities: readonly string[];
    readonly run: readonly string[];
    readonly methods?: readonly {
      behavior: string;
      type: string;
      methods: readonly string[];
    }[];
  },
  origin: "extension" | "source" | "local",
): string {
  const sorted = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify({
    origin,
    capabilities: sorted(descriptor.capabilities),
    run: sorted(descriptor.run),
    // a tuple, so a space inside a name cannot move a field boundary
    methods: sorted(
      (descriptor.methods ?? []).map(({ behavior, type, methods }) =>
        JSON.stringify([behavior, type, sorted(methods)])
      ),
    ),
  });
}

/** The last segment of an app name, which names its folder under `apps/`. */
export function appFolderName(name: string): string {
  const segments = name.split("/");
  return segments[segments.length - 1];
}

/** The collective in an app name, without its `@`. */
export function appCollective(name: string): string {
  return name.slice(1).split("/")[0];
}

/** a name holds `@` and `/`, so a store key or filename keeps this form of it */
export function appNameKey(name: string): string {
  return [...new TextEncoder().encode(name)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
