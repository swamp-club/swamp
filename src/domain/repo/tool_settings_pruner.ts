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

import { dirname, join, SEPARATOR } from "@std/path";
import { assertNever } from "../errors.ts";
import type { AiTool } from "./ai_tool.ts";
import {
  isKiroAuditCommand,
  isKiroAuditHookEntry,
  isSwampAuditCommand,
  swampAuditCommandPattern,
} from "./audit_hook_command.ts";
import { BUILT_IN_TOOL_NAMES, isBuiltInTool } from "./custom_tool.ts";

const CLAUDE_AUDIT_PATTERN = swampAuditCommandPattern("(?: --tool claude)?");
const CURSOR_AUDIT_PATTERN = swampAuditCommandPattern(" --tool cursor");
const COPILOT_AUDIT_PATTERN = swampAuditCommandPattern(" --tool copilot");

const MANAGED_FILE_MARKER =
  "// This is a managed file — it will be overwritten on swamp upgrade.";
const MANAGED_HEADER_LINES = 10;

export interface PruneSkip {
  tool: AiTool;
  path: string;
  reason: string;
}

interface PruneActionBase {
  tool: AiTool;
  /** repo-relative, with forward slashes */
  path: string;
  removed: string[];
  /** the file's text when found; apply skips the file if it has changed */
  original: string;
}

export type PruneAction =
  | (PruneActionBase & { kind: "delete" })
  | (PruneActionBase & { kind: "edit"; content: string });

export interface PrunePlan {
  actions: PruneAction[];
  skipped: PruneSkip[];
}

export interface PruneOutcome {
  applied: PruneAction[];
  skipped: PruneSkip[];
}

/** must replace the file (temp file and rename), never write through a symlink */
export type WriteTextFile = (path: string, content: string) => Promise<void>;

type JsonObject = Record<string, unknown>;

interface RuleResult {
  result: JsonObject;
  removed: string[];
}

type JsonRule = (file: JsonObject) => RuleResult | undefined;

type Target =
  | { kind: "absent" }
  | { kind: "skip"; reason: string }
  | { kind: "file"; abs: string; text: string };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeCommand(command: unknown): string {
  return typeof command === "string" ? command.trim() : String(command);
}

function pruneClaudeSettings(settings: JsonObject): RuleResult | undefined {
  if (!isRecord(settings.hooks)) return undefined;
  const removed: string[] = [];
  const hooks: JsonObject = {};
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) {
      hooks[event] = entries;
      continue;
    }
    const before = removed.length;
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        kept.push(entry);
        continue;
      }
      // a swamp hook runs swamp under any matcher, so the matcher is not
      // consulted here
      const inner = entry.hooks.filter((hook) => {
        const ours = isRecord(hook) &&
          isSwampAuditCommand(hook.command, CLAUDE_AUDIT_PATTERN);
        if (ours) removed.push(`${event}: ${describeCommand(hook.command)}`);
        return !ours;
      });
      if (inner.length === entry.hooks.length) kept.push(entry);
      else if (inner.length > 0) kept.push({ ...entry, hooks: inner });
    }
    if (removed.length > before && kept.length === 0) continue;
    hooks[event] = kept;
  }
  if (removed.length === 0) return undefined;
  const result = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete (result as JsonObject).hooks;
  return { result, removed };
}

function flatHooksRule(pattern: RegExp): JsonRule {
  return (file) => {
    if (!isRecord(file.hooks)) return undefined;
    const removed: string[] = [];
    const hooks: JsonObject = {};
    for (const [event, entries] of Object.entries(file.hooks)) {
      if (!Array.isArray(entries)) {
        hooks[event] = entries;
        continue;
      }
      const before = removed.length;
      const kept = entries.filter((entry) => {
        const ours = isRecord(entry) &&
          isSwampAuditCommand(entry.command, pattern);
        if (ours) removed.push(`${event}: ${describeCommand(entry.command)}`);
        return !ours;
      });
      if (removed.length > before && kept.length === 0) continue;
      hooks[event] = kept;
    }
    if (removed.length === 0) return undefined;
    const result: JsonObject = { ...file, hooks };
    if (Object.keys(hooks).length === 0) delete result.hooks;
    return { result, removed };
  };
}

// swamp overwrites this block on every upgrade, so the whole block is its own
function pruneAntigravityHooks(file: JsonObject): RuleResult | undefined {
  if (!("swamp-audit" in file)) return undefined;
  const { "swamp-audit": _, ...rest } = file;
  return { result: rest, removed: ["swamp-audit hook block"] };
}

function pruneKiroHookFile(file: JsonObject): RuleResult | undefined {
  if (file.version !== "v1" || !Array.isArray(file.hooks)) return undefined;
  const removed: string[] = [];
  const kept = file.hooks.filter((hook) => {
    const ours = isKiroAuditHookEntry(hook);
    if (ours) {
      const action = (hook as { action: { command: unknown } }).action;
      removed.push(`hook: ${describeCommand(action.command)}`);
    }
    return !ours;
  });
  if (removed.length === 0) return undefined;
  const result: JsonObject = { ...file, hooks: kept };
  if (kept.length === 0) delete result.hooks;
  return { result, removed };
}

function pruneLegacyKiroHook(file: JsonObject): RuleResult | undefined {
  const then = file.then;
  if (!isRecord(then) || !isKiroAuditCommand(then.command)) return undefined;
  return { result: {}, removed: [`hook: ${describeCommand(then.command)}`] };
}

// swamp overwrites the swamp agent on every upgrade, so the file is its own
function pruneKiroAgent(file: JsonObject): RuleResult | undefined {
  if (file.name !== "swamp") return undefined;
  return { result: {}, removed: ["swamp agent"] };
}

function pruneKiroCliDefaultAgent(file: JsonObject): RuleResult | undefined {
  if (file["chat.defaultAgent"] !== "swamp") return undefined;
  const { "chat.defaultAgent": _, ...rest } = file;
  return { result: rest, removed: ['chat.defaultAgent: "swamp"'] };
}

/**
 * finds and removes the settings swamp manages for built-in tools that are not
 * enrolled: audit hook entries that are exactly swamp's command, files swamp
 * overwrites on every upgrade, and the Kiro default agent when it is swamp's
 */
export class ToolSettingsPruner {
  constructor(
    private readonly repoRoot: string,
    private readonly writeTextFile: WriteTextFile,
  ) {}

  async find(enrolledTools: readonly string[]): Promise<PrunePlan> {
    const plan: PrunePlan = { actions: [], skipped: [] };
    const realRoot = await Deno.realPath(this.repoRoot);
    for (const name of BUILT_IN_TOOL_NAMES) {
      if (!isBuiltInTool(name) || enrolledTools.includes(name)) continue;
      await this.findForTool(name, realRoot, plan);
    }
    return plan;
  }

  async apply(plan: PrunePlan): Promise<PruneOutcome> {
    const realRoot = await Deno.realPath(this.repoRoot);
    const applied: PruneAction[] = [];
    const skipped: PruneSkip[] = [...plan.skipped];
    for (const action of plan.actions) {
      const target = await this.readTarget(realRoot, action.path);
      if (target.kind !== "file" || target.text !== action.original) {
        skipped.push({
          tool: action.tool,
          path: action.path,
          reason: target.kind === "absent"
            ? "it was removed after it was found"
            : target.kind === "skip"
            ? target.reason
            : "it changed after it was found",
        });
        continue;
      }
      if (action.kind === "delete") {
        await Deno.remove(target.abs);
      } else {
        await this.writeTextFile(target.abs, action.content);
      }
      applied.push(action);
    }
    return { applied, skipped };
  }

  private async findForTool(
    tool: AiTool,
    realRoot: string,
    plan: PrunePlan,
  ): Promise<void> {
    const json = (path: string, rule: JsonRule, ignorable: string[] = []) =>
      this.planJson(tool, realRoot, path, rule, ignorable, false, plan);
    switch (tool) {
      case "claude":
        await json(".claude/settings.local.json", pruneClaudeSettings);
        return;
      case "cursor":
        await json(".cursor/hooks.json", flatHooksRule(CURSOR_AUDIT_PATTERN), [
          "version",
        ]);
        return;
      case "copilot":
        await json(
          ".github/hooks/swamp-audit.json",
          flatHooksRule(COPILOT_AUDIT_PATTERN),
          ["version"],
        );
        return;
      case "antigravity":
        await json(".agents/hooks.json", pruneAntigravityHooks);
        return;
      case "kiro":
        await this.planKiroHooks(realRoot, plan);
        await json(".kiro/hooks/swamp-audit.kiro.hook", pruneLegacyKiroHook);
        await json(".kiro/agents/swamp.json", pruneKiroAgent);
        await json(".kiro/settings/cli.json", pruneKiroCliDefaultAgent);
        return;
      case "opencode":
        await this.planManagedFile(
          tool,
          realRoot,
          ".opencode/plugins/swamp-audit.ts",
          plan,
        );
        return;
      case "pi":
        await this.planManagedFile(
          tool,
          realRoot,
          ".pi/extensions/swamp-audit.ts",
          plan,
        );
        return;
      case "amp":
        await this.planManagedFile(
          tool,
          realRoot,
          ".amp/plugins/swamp.ts",
          plan,
        );
        return;
      case "codex":
      case "none":
        return;
      default:
        assertNever(tool);
    }
  }

  private async planKiroHooks(
    realRoot: string,
    plan: PrunePlan,
  ): Promise<void> {
    const dir = ".kiro/hooks";
    const abs = join(this.repoRoot, ...dir.split("/"));
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(abs);
    } catch {
      return;
    }
    if (info.isSymlink) {
      plan.skipped.push({
        tool: "kiro",
        path: dir,
        reason: "it is a symbolic link",
      });
      return;
    }
    if (!info.isDirectory) return;
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(abs)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          names.push(entry.name);
        }
      }
    } catch {
      plan.skipped.push({
        tool: "kiro",
        path: dir,
        reason: "it could not be read",
      });
      return;
    }
    // most of these files are the user's own, so one that does not parse is
    // passed over without a report
    for (const name of names.sort()) {
      await this.planJson(
        "kiro",
        realRoot,
        `${dir}/${name}`,
        pruneKiroHookFile,
        ["version"],
        true,
        plan,
      );
    }
  }

  private async planJson(
    tool: AiTool,
    realRoot: string,
    path: string,
    rule: JsonRule,
    ignorable: string[],
    quiet: boolean,
    plan: PrunePlan,
  ): Promise<void> {
    const target = await this.readTarget(realRoot, path);
    if (target.kind === "absent") return;
    if (target.kind === "skip") {
      plan.skipped.push({ tool, path, reason: target.reason });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(target.text);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      if (!quiet) {
        plan.skipped.push({
          tool,
          path,
          reason: "it does not hold a JSON object",
        });
      }
      return;
    }
    const outcome = rule(parsed);
    if (!outcome) return;
    const leftover = Object.keys(outcome.result).filter((key) =>
      !ignorable.includes(key)
    );
    if (leftover.length === 0) {
      plan.actions.push({
        tool,
        path,
        kind: "delete",
        removed: outcome.removed,
        original: target.text,
      });
    } else {
      plan.actions.push({
        tool,
        path,
        kind: "edit",
        removed: outcome.removed,
        original: target.text,
        content: JSON.stringify(outcome.result, null, 2) + "\n",
      });
    }
  }

  private async planManagedFile(
    tool: AiTool,
    realRoot: string,
    path: string,
    plan: PrunePlan,
  ): Promise<void> {
    const target = await this.readTarget(realRoot, path);
    if (target.kind === "absent") return;
    if (target.kind === "skip") {
      plan.skipped.push({ tool, path, reason: target.reason });
      return;
    }
    const header = target.text.split("\n", MANAGED_HEADER_LINES);
    if (!header.some((line) => line.trim() === MANAGED_FILE_MARKER)) {
      plan.skipped.push({
        tool,
        path,
        reason: "it no longer carries swamp's managed-file header",
      });
      return;
    }
    plan.actions.push({
      tool,
      path,
      kind: "delete",
      removed: ["swamp-managed file"],
      original: target.text,
    });
  }

  // the paths are fixed, but the repo is user-controlled: a symlinked file or
  // a tool directory resolving outside the repo is never read or written
  private async readTarget(realRoot: string, path: string): Promise<Target> {
    const abs = join(this.repoRoot, ...path.split("/"));
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(abs);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.NotADirectory
      ) {
        return { kind: "absent" };
      }
      return { kind: "skip", reason: "it could not be read" };
    }
    if (info.isSymlink) {
      return { kind: "skip", reason: "it is a symbolic link" };
    }
    if (!info.isFile) {
      return { kind: "skip", reason: "it is not a regular file" };
    }
    let realParent: string;
    try {
      realParent = await Deno.realPath(dirname(abs));
    } catch {
      return { kind: "skip", reason: "its directory could not be resolved" };
    }
    const prefix = realRoot.endsWith(SEPARATOR)
      ? realRoot
      : realRoot + SEPARATOR;
    if (realParent !== realRoot && !realParent.startsWith(prefix)) {
      return { kind: "skip", reason: "it resolves outside the repository" };
    }
    try {
      return { kind: "file", abs, text: await Deno.readTextFile(abs) };
    } catch {
      return { kind: "skip", reason: "it could not be read" };
    }
  }
}
