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

/**
 * Skill review script that runs `npx tessl skill review` on each bundled skill
 * and reports scores. Fails if any skill's average score drops below 90%.
 *
 * Usage: deno run review-skills
 *
 * Exit codes:
 *   0 - All skills pass the 90% threshold
 *   1 - One or more skills below threshold or review failure
 */

import { SkillAssets } from "../src/infrastructure/assets/skill_assets.ts";

const THRESHOLD = 0.9;

interface ReviewResult {
  validation: { overallPassed: boolean };
  descriptionJudge: { normalizedScore: number };
  contentJudge: { normalizedScore: number };
}

interface SkillScore {
  name: string;
  descriptionScore: number;
  contentScore: number;
  averageScore: number;
  validationPassed: boolean;
}

async function reviewSkill(skillDir: string): Promise<ReviewResult> {
  const command = new Deno.Command("npx", {
    args: ["tessl", "skill", "review", skillDir, "--json"],
    stdout: "piped",
    stderr: "piped",
  });

  const output = await command.output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`tessl review failed for ${skillDir}: ${stderr}`);
  }

  const stdout = new TextDecoder().decode(output.stdout);

  // npx may write download/install progress to stdout before/after the JSON.
  // Extract the JSON object by finding the first '{' and its matching '}'.
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(
      `tessl review returned no JSON for ${skillDir}: ${stdout}`,
    );
  }

  let depth = 0;
  let jsonEnd = -1;
  for (let i = jsonStart; i < stdout.length; i++) {
    if (stdout[i] === "{") depth++;
    else if (stdout[i] === "}") {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd === -1) {
    throw new Error(
      `tessl review returned malformed JSON for ${skillDir}: ${stdout}`,
    );
  }

  const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd)) as Record<
    string,
    unknown
  >;

  // Validate required fields are present and scores are finite numbers
  const descScore =
    (parsed.descriptionJudge as Record<string, unknown> | undefined)
      ?.normalizedScore;
  const contScore =
    (parsed.contentJudge as Record<string, unknown> | undefined)
      ?.normalizedScore;

  if (
    typeof descScore !== "number" || !Number.isFinite(descScore) ||
    typeof contScore !== "number" || !Number.isFinite(contScore)
  ) {
    throw new Error(
      `Invalid scores from tessl for ${skillDir}: desc=${descScore}, content=${contScore}`,
    );
  }

  const validation = parsed.validation as
    | Record<string, unknown>
    | undefined;
  if (typeof validation?.overallPassed !== "boolean") {
    throw new Error(
      `Invalid validation result from tessl for ${skillDir}`,
    );
  }

  return {
    validation: { overallPassed: validation.overallPassed },
    descriptionJudge: { normalizedScore: descScore },
    contentJudge: { normalizedScore: contScore },
  };
}

function buildSummaryTable(scores: SkillScore[], allPassed: boolean): string {
  const lines: string[] = ["## Skill Review Results\n"];

  lines.push("| Skill | Description | Content | Average | Status |");
  lines.push("|-------|------------|---------|---------|--------|");

  for (const score of scores) {
    const desc = `${(score.descriptionScore * 100).toFixed(0)}%`;
    const content = `${(score.contentScore * 100).toFixed(0)}%`;
    const avg = `${(score.averageScore * 100).toFixed(0)}%`;
    const status = score.averageScore >= THRESHOLD && score.validationPassed
      ? "Pass"
      : "Fail";
    lines.push(`| ${score.name} | ${desc} | ${content} | ${avg} | ${status} |`);
  }

  lines.push("");

  if (allPassed) {
    lines.push("All skills pass the 90% threshold.");
  } else {
    lines.push("One or more skills failed the 90% threshold.");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const assets = new SkillAssets();
  const skillNames = assets.getSkillNames();

  console.log(`Reviewing ${skillNames.length} skills…`);

  const scores: SkillScore[] = [];
  let allPassed = true;

  for (const name of skillNames) {
    const skillDir = `.claude/skills/${name}`;
    console.log(`  Reviewing ${name}…`);

    try {
      const result = await reviewSkill(skillDir);
      const descriptionScore = result.descriptionJudge.normalizedScore;
      const contentScore = result.contentJudge.normalizedScore;
      const averageScore = (descriptionScore + contentScore) / 2;
      const validationPassed = result.validation.overallPassed;

      scores.push({
        name,
        descriptionScore,
        contentScore,
        averageScore,
        validationPassed,
      });

      if (averageScore < THRESHOLD || !validationPassed) {
        allPassed = false;
      }

      console.log(
        `    ${name}: ${(averageScore * 100).toFixed(0)}% (desc=${(descriptionScore * 100).toFixed(0)}%, content=${(contentScore * 100).toFixed(0)}%)`,
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`    Failed to review ${name}: ${msg}`);
      scores.push({
        name,
        descriptionScore: 0,
        contentScore: 0,
        averageScore: 0,
        validationPassed: false,
      });
      allPassed = false;
    }
  }

  // Write GitHub Actions summary
  const summary = buildSummaryTable(scores, allPassed);
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    await Deno.writeTextFile(summaryFile, summary);
  } else {
    console.log(`\n${summary}`);
  }

  if (!allPassed) {
    console.error("\nSkill review failed: one or more skills below threshold.");
    Deno.exit(1);
  }

  console.log("\nAll skills passed review.");
  Deno.exit(0);
}

main();
