import { dirname } from "@std/path";

/**
 * Removes empty parent directories up to but not including the stopAt directory.
 *
 * This is useful when deleting files from nested directory structures
 * (e.g., data/inputs/aws/ec2/vpc/uuid.yaml) to clean up empty folders.
 *
 * @param filePath The path of the file that was deleted
 * @param stopAtDir The directory to stop at (will not be deleted)
 */
export async function cleanupEmptyParentDirs(
  filePath: string,
  stopAtDir: string,
): Promise<void> {
  let currentDir = dirname(filePath);

  while (currentDir !== stopAtDir && currentDir.startsWith(stopAtDir)) {
    try {
      // Check if directory is empty
      const entries = [];
      for await (const entry of Deno.readDir(currentDir)) {
        entries.push(entry);
      }

      if (entries.length === 0) {
        await Deno.remove(currentDir);
        currentDir = dirname(currentDir);
      } else {
        // Directory not empty, stop cleaning
        break;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Directory already gone, try parent
        currentDir = dirname(currentDir);
      } else {
        // Other error, stop cleaning
        break;
      }
    }
  }
}
