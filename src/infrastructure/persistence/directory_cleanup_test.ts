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
    // Create nested directory structure: tempDir/data/inputs/aws/ec2/vpc
    const inputsDir = join(tempDir, ".swamp", "inputs");
    const vpcDir = join(inputsDir, "aws", "ec2", "vpc");
    await ensureDir(vpcDir);

    // Create a file in vpc directory
    const filePath = join(vpcDir, "test.yaml");
    await Deno.writeTextFile(filePath, "test: content");

    // Delete the file
    await Deno.remove(filePath);

    // Clean up empty parent directories
    await cleanupEmptyParentDirs(filePath, inputsDir);

    // All nested directories should be removed
    assertEquals(await exists(join(inputsDir, "aws", "ec2", "vpc")), false);
    assertEquals(await exists(join(inputsDir, "aws", "ec2")), false);
    assertEquals(await exists(join(inputsDir, "aws")), false);

    // But inputs directory should still exist (it's the stop point)
    assertEquals(await exists(inputsDir), true);
  });
});

Deno.test("cleanupEmptyParentDirs stops at non-empty directory", async () => {
  await withTempDir(async (tempDir) => {
    // Create nested directory structure
    const inputsDir = join(tempDir, ".swamp", "inputs");
    const vpcDir = join(inputsDir, "aws", "ec2", "vpc");
    const subnetDir = join(inputsDir, "aws", "ec2", "subnet");
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
    await cleanupEmptyParentDirs(vpcFile, inputsDir);

    // vpc directory should be removed
    assertEquals(await exists(vpcDir), false);

    // ec2 directory should still exist (it has subnet subdir)
    assertEquals(await exists(join(inputsDir, "aws", "ec2")), true);

    // aws directory should still exist
    assertEquals(await exists(join(inputsDir, "aws")), true);

    // subnet directory and file should still exist
    assertEquals(await exists(subnetDir), true);
    assertEquals(await exists(subnetFile), true);
  });
});

Deno.test("cleanupEmptyParentDirs handles already deleted directories", async () => {
  await withTempDir(async (tempDir) => {
    const inputsDir = join(tempDir, ".swamp", "inputs");
    await ensureDir(inputsDir);

    // Try to clean up a path that doesn't exist
    const nonExistentFile = join(inputsDir, "aws", "ec2", "vpc", "test.yaml");

    // Should not throw
    await cleanupEmptyParentDirs(nonExistentFile, inputsDir);

    // inputs directory should still exist
    assertEquals(await exists(inputsDir), true);
  });
});

Deno.test("cleanupEmptyParentDirs does not go above stop directory", async () => {
  await withTempDir(async (tempDir) => {
    // Create structure
    const dataDir = join(tempDir, ".swamp");
    const inputsDir = join(dataDir, "inputs");
    const typeDir = join(inputsDir, "swamp", "echo");
    await ensureDir(typeDir);

    // Create and delete a file
    const filePath = join(typeDir, "test.yaml");
    await Deno.writeTextFile(filePath, "test: content");
    await Deno.remove(filePath);

    // Clean up with inputs as stop directory
    await cleanupEmptyParentDirs(filePath, inputsDir);

    // Nested dirs should be removed
    assertEquals(await exists(typeDir), false);
    assertEquals(await exists(join(inputsDir, "swamp")), false);

    // But inputs and data should still exist
    assertEquals(await exists(inputsDir), true);
    assertEquals(await exists(dataDir), true);
  });
});
