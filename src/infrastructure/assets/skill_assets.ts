import { join } from "@std/path";

/**
 * Represents a skill that can be bundled with swamp.
 */
export interface SkillInfo {
  /** Relative path from .claude/skills (e.g., "swamp-model/SKILL.md") */
  relativePath: string;
  /** Skill name derived from directory (e.g., "swamp-model") */
  name: string;
}

/**
 * List of skills to bundle with the swamp binary.
 */
const BUNDLED_SKILLS: SkillInfo[] = [
  { relativePath: "swamp-model/SKILL.md", name: "swamp-model" },
];

/**
 * SkillAssets provides access to embedded skill files.
 *
 * When running from source, skills are read from the .claude/skills directory.
 * When running from a compiled binary, skills are embedded using Deno's --include flag.
 */
export class SkillAssets {
  private readonly skillsDir: string;

  constructor() {
    // import.meta.dirname gives the directory of this file
    // Navigate up to repo root and then to .claude/skills
    const currentDir = import.meta.dirname ?? ".";
    // From src/infrastructure/assets -> ../../.. -> repo root
    this.skillsDir = join(currentDir, "..", "..", "..", ".claude", "skills");
  }

  /**
   * Gets the base skills directory path.
   */
  getSkillsDir(): string {
    return this.skillsDir;
  }

  /**
   * Lists all bundled skills.
   */
  listSkills(): SkillInfo[] {
    return [...BUNDLED_SKILLS];
  }

  /**
   * Gets unique skill names (directories).
   */
  getSkillNames(): string[] {
    const names = new Set(BUNDLED_SKILLS.map((s) => s.name));
    return Array.from(names);
  }

  /**
   * Reads a skill file by its relative path.
   *
   * @param relativePath - Path relative to .claude/skills (e.g., "swamp-model/SKILL.md")
   * @returns The file content, or null if not found
   */
  async readSkill(relativePath: string): Promise<string | null> {
    const path = join(this.skillsDir, relativePath);
    try {
      return await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Gets the full path for a skill file.
   */
  getSkillPath(relativePath: string): string {
    return join(this.skillsDir, relativePath);
  }

  /**
   * Copies all bundled skills to a target directory.
   *
   * @param targetDir - The target .claude/skills directory
   */
  async copySkillsTo(targetDir: string): Promise<void> {
    for (const skill of BUNDLED_SKILLS) {
      const sourcePath = join(this.skillsDir, skill.relativePath);
      const targetPath = join(targetDir, skill.relativePath);

      // Read the source file
      const content = await Deno.readTextFile(sourcePath);

      // Ensure target directory exists
      const targetParent = join(targetPath, "..");
      await Deno.mkdir(targetParent, { recursive: true });

      // Write to target
      await Deno.writeTextFile(targetPath, content);
    }
  }
}
