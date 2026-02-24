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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cleanup-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("cleanupEmptyParentDirs removes empty parent directories", async () => {
  await withTempDir(async (tempDir) => {
    // Create nested directory structure: tempDir/.swamp/data/aws/ec2/vpc
    const dataDir = join(tempDir, ".swamp", "data");
    const vpcDir = join(dataDir, "aws", "ec2", "vpc");
    await ensureDir(vpcDir);

    // Create a file in vpc directory
    const filePath = join(vpcDir, "test.yaml");
    await Deno.writeTextFile(filePath, "test: content");

    // Delete the file
    await Deno.remove(filePath);

    // Clean up empty parent directories
    await cleanupEmptyParentDirs(filePath, dataDir);

    // All nested directories should be removed
    assertEquals(await exists(join(dataDir, "aws", "ec2", "vpc")), false);
    assertEquals(await exists(join(dataDir, "aws", "ec2")), false);
    assertEquals(await exists(join(dataDir, "aws")), false);

    // But data directory should still exist (it's the stop point)
    assertEquals(await exists(dataDir), true);
  });
});

Deno.test("cleanupEmptyParentDirs stops at non-empty directory", async () => {
  await withTempDir(async (tempDir) => {
    // Create nested directory structure
    const dataDir = join(tempDir, ".swamp", "data");
    const vpcDir = join(dataDir, "aws", "ec2", "vpc");
    const subnetDir = join(dataDir, "aws", "ec2", "subnet");
    await ensureDir(vpcDir);
    await ensureDir(subnetDir);

    // Create a file in vpc directory
    const vpcFile = join(vpcDir, "vpc.yaml");
    await Deno.writeTextFile(vpcFile, "test: content");

    // Create a file in subnet directory
    const subnetFile = join(subnetDir, "subnet.yaml");
    await Deno.writeTextFile(subnetFile, "test: content");

    // Delete the vpc file
    await Deno.remove(vpcFile);

    // Clean up empty parent directories
    await cleanupEmptyParentDirs(vpcFile, dataDir);

    // vpc directory should be removed
    assertEquals(await exists(vpcDir), false);

    // ec2 directory should still exist (it has subnet subdir)
    assertEquals(await exists(join(dataDir, "aws", "ec2")), true);

    // aws directory should still exist
    assertEquals(await exists(join(dataDir, "aws")), true);

    // subnet directory and file should still exist
    assertEquals(await exists(subnetDir), true);
    assertEquals(await exists(subnetFile), true);
  });
});

Deno.test("cleanupEmptyParentDirs handles already deleted directories", async () => {
  await withTempDir(async (tempDir) => {
    const dataDir = join(tempDir, ".swamp", "data");
    await ensureDir(dataDir);

    // Try to clean up a path that doesn't exist
    const nonExistentFile = join(dataDir, "aws", "ec2", "vpc", "test.yaml");

    // Should not throw
    await cleanupEmptyParentDirs(nonExistentFile, dataDir);

    // data directory should still exist
    assertEquals(await exists(dataDir), true);
  });
});

Deno.test("cleanupEmptyParentDirs does not go above stop directory", async () => {
  await withTempDir(async (tempDir) => {
    // Create structure
    const swampDir = join(tempDir, ".swamp");
    const dataDir = join(swampDir, "data");
    const typeDir = join(dataDir, "swamp", "echo");
    await ensureDir(typeDir);

    // Create and delete a file
    const filePath = join(typeDir, "test.yaml");
    await Deno.writeTextFile(filePath, "test: content");
    await Deno.remove(filePath);

    // Clean up with data as stop directory
    await cleanupEmptyParentDirs(filePath, dataDir);

    // Nested dirs should be removed
    assertEquals(await exists(typeDir), false);
    assertEquals(await exists(join(dataDir, "swamp")), false);

    // But data and swamp should still exist
    assertEquals(await exists(dataDir), true);
    assertEquals(await exists(swampDir), true);
  });
});
