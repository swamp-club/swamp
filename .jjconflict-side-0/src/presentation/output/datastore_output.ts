// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { bold, dim, green, red, yellow } from "@std/fmt/colors";
import type { OutputMode } from "./output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";

export interface DatastoreStatusData {
  type: string;
  path?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  healthy: boolean;
  message: string;
  latencyMs: number;
  directories: string[];
  exclude?: string[];
}

export function renderDatastoreStatus(
  data: DatastoreStatusData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const healthIcon = data.healthy ? green("●") : red("●");
  const healthText = data.healthy ? green("healthy") : red("unhealthy");

  const lines = [
    bold("Datastore Status"),
    `  Type:    ${data.type}`,
  ];
  if (data.path) {
    lines.push(`  Path:    ${data.path}`);
  }
  if (data.bucket) {
    lines.push(`  Bucket:  ${data.bucket}`);
  }
  if (data.prefix) {
    lines.push(`  Prefix:  ${data.prefix}`);
  }
  if (data.region) {
    lines.push(`  Region:  ${data.region}`);
  }
  lines.push(
    `  Health:  ${healthIcon} ${healthText} (${Math.round(data.latencyMs)}ms)`,
  );
  if (!data.healthy) {
    lines.push(`  Error:   ${data.message}`);
  }
  lines.push(`  Dirs:    ${data.directories.join(", ")}`);
  if (data.exclude && data.exclude.length > 0) {
    lines.push(`  Exclude: ${data.exclude.join(", ")}`);
  }

  writeOutput(lines.join("\n"));
}

export interface DatastoreSetupData {
  type: string;
  path?: string;
  bucket?: string;
  prefix?: string;
  filesCopied: number;
  bytesCopied: number;
  directoriesMigrated: string[];
  errors: string[];
}

export function renderDatastoreSetup(
  data: DatastoreSetupData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const lines = [
    bold("Datastore Setup Complete"),
    `  Type:     ${data.type}`,
  ];
  if (data.path) {
    lines.push(`  Path:     ${data.path}`);
  }
  if (data.bucket) {
    lines.push(`  Bucket:   ${data.bucket}`);
  }
  lines.push(
    `  Files:    ${data.filesCopied} copied (${formatBytes(data.bytesCopied)})`,
  );
  lines.push(`  Dirs:     ${data.directoriesMigrated.join(", ")}`);

  if (data.errors.length > 0) {
    lines.push("");
    lines.push(yellow("Warnings:"));
    for (const err of data.errors) {
      lines.push(`  ${yellow("!")} ${err}`);
    }
  }

  writeOutput(lines.join("\n"));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface DatastoreLockStatusData {
  held: boolean;
  info?: LockInfo;
  datastoreType: string;
  /** If set, identifies this as a per-model lock (e.g. "aws-ec2/my-server"). */
  lockScope?: string;
}

export function renderDatastoreLockStatus(
  data: DatastoreLockStatusData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.info ?? null, null, 2));
    return;
  }

  const scopeLabel = data.lockScope ? ` [${data.lockScope}]` : "";

  if (!data.held || !data.info) {
    writeOutput(
      `${bold("Lock Status:")} ${green("no lock held")}${scopeLabel}`,
    );
    return;
  }

  const info = data.info;
  const ageMs = Date.now() - new Date(info.acquiredAt).getTime();
  const ageSec = Math.round(ageMs / 1000);

  const lines = [
    `${bold("Lock Status:")} ${red("locked")}${scopeLabel}`,
    `  Holder:   ${info.holder}`,
    `  PID:      ${info.pid}`,
    `  Hostname: ${info.hostname}`,
    `  Acquired: ${info.acquiredAt} ${dim(`(${ageSec}s ago)`)}`,
    `  TTL:      ${info.ttlMs}ms`,
    `  Backend:  ${data.datastoreType}`,
  ];
  if (data.lockScope) {
    lines.push(`  Scope:    ${data.lockScope}`);
  }

  writeOutput(lines.join("\n"));
}

export interface DatastoreLockReleaseData {
  released: boolean;
  reason?: string;
  previousHolder?: LockInfo;
}

export function renderDatastoreLockRelease(
  data: DatastoreLockReleaseData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!data.released) {
    writeOutput(
      `${bold("Lock Release:")} ${dim(data.reason ?? "nothing to release")}`,
    );
    return;
  }

  const lines = [bold("Lock Released")];
  if (data.previousHolder) {
    lines.push(
      `  Previous holder: ${data.previousHolder.holder} (pid ${data.previousHolder.pid})`,
    );
  }

  writeOutput(lines.join("\n"));
}
