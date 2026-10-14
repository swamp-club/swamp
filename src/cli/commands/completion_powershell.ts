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

import { type Argument, Command, FileType } from "@cliffy/command";
import { stripAnsiCode } from "@std/fmt/colors";

// deno-lint-ignore no-explicit-any
type AnyCommand = Command<any>;

/** How a positional argument or an option value completes. */
interface ValueCompletion {
  /** The Cliffy completion action passed to `completions complete`. */
  action: string;
  /** True when the value is a path: PowerShell's own path completion runs. */
  file: boolean;
}

interface CommandEntry {
  name: string;
  aliases: string[];
  description: string;
}

interface OptionEntry {
  flags: string[];
  /** True when the option requires a value, so the next word is that value. */
  takesValue: boolean;
  value?: ValueCompletion;
  description: string;
}

interface ArgumentEntry extends ValueCompletion {
  variadic: boolean;
}

interface TreeNode {
  /** The command path below the main command, `""` for the main command. */
  path: string;
  commands: CommandEntry[];
  options: OptionEntry[];
  arguments: ArgumentEntry[];
}

/**
 * Generates a PowerShell completion script for `cmd`, which is registered for
 * `name` and `name.exe`. Cliffy 1.x has no PowerShell generator, so swamp owns
 * this one. Like Cliffy's bash, fish and zsh scripts, it embeds the command
 * tree (hidden commands and options left out) and asks
 * `<name> completions complete <action> <path>` for dynamic values such as
 * model and workflow names. Unlike the bash and fish scripts it also offers
 * command aliases. The script only uses Windows PowerShell 5.1 syntax, so it
 * loads in 5.1 and in PowerShell 7.
 */
export function generatePowerShellCompletions(
  name: string,
  cmd: AnyCommand,
): string {
  if (!name || name === "COMMAND") {
    throw new Error(
      "Failed to generate shell completions. Missing main command name. " +
        "Use '--name' to set the name of the main command.",
    );
  }
  const nodes: TreeNode[] = [];
  collectNodes(cmd, "", nodes);
  const version = cmd.getVersion() ? ` v${cmd.getVersion()}` : "";

  return `# powershell completion support for ${name}${version}
#
# Load it from your PowerShell profile:
#
#   ${name} completions powershell | Out-String | Invoke-Expression

& {
  $commandName = ${quote(name)}
  $tree = @{
${nodes.map(renderNode).join("\n")}
  }
${COMPLETER}
}`;
}

function collectNodes(cmd: AnyCommand, path: string, into: TreeNode[]): void {
  const children = cmd.getCommands(false);
  into.push({
    path,
    commands: children.map((child) => ({
      name: child.getName(),
      aliases: child.getAliases(),
      description: firstLine(child.getShortDescription()),
    })),
    options: cmd.getOptions(false).map((option) => {
      const arg: Argument | undefined = option.args[0];
      return {
        flags: option.flags,
        takesValue: arg !== undefined && !arg.optional,
        value: arg ? valueCompletion(cmd, arg) : undefined,
        description: firstLine(option.description ?? ""),
      };
    }),
    arguments: cmd.getArguments().map((arg) => ({
      ...valueCompletion(cmd, arg),
      variadic: arg.variadic === true,
    })),
  });
  for (const child of children) {
    const childPath = path ? `${path} ${child.getName()}` : child.getName();
    collectNodes(child, childPath, into);
  }
}

/**
 * The completion for `arg`. The action is kept only when `cmd` has a
 * completion registered for it (a completing type such as `model_name`, or
 * `.complete()`), so a TAB on a plain `string` argument does not start swamp
 * just to get nothing back.
 */
function valueCompletion(cmd: AnyCommand, arg: Argument): ValueCompletion {
  const type = cmd.getType(arg.type);
  return {
    action: cmd.getCompletion(arg.action) ? arg.action : "",
    file: type !== undefined && type.handler instanceof FileType,
  };
}

function firstLine(text: string): string {
  return stripAnsiCode(text).split("\n")[0].trim();
}

/** A PowerShell single-quoted string literal: only `'` needs escaping. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function bool(value: boolean): string {
  return value ? "$true" : "$false";
}

function list(items: string[]): string {
  return `@(${items.join(", ")})`;
}

function renderValue(value: ValueCompletion | undefined): string {
  if (!value) return "Action = ''; File = $false";
  return `Action = ${quote(value.action)}; File = ${bool(value.file)}`;
}

function renderNode(node: TreeNode): string {
  const commands = node.commands.map((c) =>
    `@{ Name = ${quote(c.name)}; Aliases = ${
      list(c.aliases.map(quote))
    }; Description = ${quote(c.description)} }`
  );
  const options = node.options.map((o) =>
    `@{ Flags = ${list(o.flags.map(quote))}; TakesValue = ${
      bool(o.takesValue)
    }; ${renderValue(o.value)}; Description = ${quote(o.description)} }`
  );
  const args = node.arguments.map((a) =>
    `@{ ${renderValue(a)}; Variadic = ${bool(a.variadic)} }`
  );
  return `    ${quote(node.path)} = @{
      Commands = ${list(commands)}
      Options = ${list(options)}
      Arguments = ${list(args)}
    }`;
}

/**
 * The completer. It walks the words before the cursor to find the command
 * path, skipping options and their values, then completes the word under the
 * cursor. Dynamic values come from the repository (model and workflow names),
 * so they only ever become CompletionResult text, never code, and a value
 * with whitespace or a PowerShell metacharacter is inserted single-quoted.
 * Returning nothing lets PowerShell fall back to path completion.
 */
const COMPLETER =
  `  $special = (' ;,(){}[]|&<>@#$' + [char]34 + [char]39 + [char]96 + [char]9 + [char]10 + [char]13).ToCharArray()

  $completer = {
    param($wordToComplete, $commandAst, $cursorPosition)

    $path = ''
    $positional = 0
    $pendingOption = $null
    $endOfOptions = $false
    $elements = $commandAst.CommandElements
    for ($i = 1; $i -lt $elements.Count; $i++) {
      $element = $elements[$i]
      if ($element.Extent.EndOffset -ge $cursorPosition) { break }
      if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        $word = $element.Value
      } else {
        $word = $element.Extent.Text
      }
      if ($pendingOption) {
        $pendingOption = $null
        continue
      }
      if (-not $endOfOptions -and $word -eq '--') {
        $endOfOptions = $true
        continue
      }
      if (-not $endOfOptions -and $word.StartsWith('-')) {
        if ($word.Contains('=')) { continue }
        foreach ($option in $tree[$path].Options) {
          if ($option.Flags -contains $word) {
            if ($option.TakesValue) { $pendingOption = $option }
            break
          }
        }
        continue
      }
      if ($positional -eq 0) {
        $child = $null
        foreach ($command in $tree[$path].Commands) {
          if ($command.Name -eq $word -or $command.Aliases -contains $word) {
            $child = $command
            break
          }
        }
        if ($child) {
          if ($path) { $path = $path + ' ' + $child.Name } else { $path = $child.Name }
          continue
        }
      }
      $positional++
    }

    $node = $tree[$path]
    $results = New-Object System.Collections.Generic.List[System.Management.Automation.CompletionResult]

    $addResult = {
      param($text, $type, $description)
      $completion = $text
      if ($type -eq 'ParameterValue' -and $text.IndexOfAny($special) -ge 0) {
        $completion = "'" + $text.Replace("'", "''") + "'"
      }
      $toolTip = $description
      if (-not $toolTip) { $toolTip = $text }
      $results.Add((New-Object System.Management.Automation.CompletionResult($completion, $text, $type, $toolTip)))
    }

    $addDynamic = {
      param($value)
      if (-not $value.Action) { return }
      $words = @()
      if ($path) { $words = $path.Split(' ') }
      $values = & $commandName 'completions' 'complete' $value.Action @words 2>$null
      foreach ($item in @($values)) {
        $text = [string]$item
        if ($text -and $text.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
          & $addResult $text 'ParameterValue' $text
        }
      }
    }

    if ($pendingOption) {
      if ($pendingOption.File) { return }
      & $addDynamic $pendingOption
      return $results
    }

    if (-not $endOfOptions -and $wordToComplete.StartsWith('-')) {
      foreach ($option in $node.Options) {
        foreach ($flag in $option.Flags) {
          if ($flag.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
            & $addResult $flag 'ParameterName' $option.Description
          }
        }
      }
      return $results
    }

    if ($positional -eq 0) {
      foreach ($command in $node.Commands) {
        foreach ($commandWord in @($command.Name) + $command.Aliases) {
          if ($commandWord.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
            & $addResult $commandWord 'Command' $command.Description
          }
        }
      }
    }

    $argument = $null
    if ($positional -lt $node.Arguments.Count) {
      $argument = $node.Arguments[$positional]
    } elseif ($node.Arguments.Count -gt 0 -and $node.Arguments[-1].Variadic) {
      $argument = $node.Arguments[-1]
    }
    if ($argument) {
      if ($argument.File -and $results.Count -eq 0) { return }
      if (-not $argument.File) { & $addDynamic $argument }
    }

    if ($results.Count -eq 0) { return }
    return $results
  }.GetNewClosure()

  Register-ArgumentCompleter -Native -CommandName @($commandName, ($commandName + '.exe')) -ScriptBlock $completer`;

/** `swamp completions powershell`: prints the PowerShell completion script. */
export const powerShellCompletionsCommand = new Command()
  .description(
    `Generate shell completions for PowerShell.

To enable PowerShell completions for this program add the following line to your PowerShell profile:

    swamp completions powershell | Out-String | Invoke-Expression`,
  )
  .noGlobals()
  .option("-n, --name <command-name:string>", "The name of the main command.")
  .action(function ({ name }) {
    const main = this.getMainCommand() as AnyCommand;
    console.log(generatePowerShellCompletions(name ?? main.getName(), main));
  });
