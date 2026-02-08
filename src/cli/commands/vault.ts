import { Command } from "@cliffy/command";
import { vaultTypeSearchCommand } from "./vault_type_search.ts";
import { vaultCreateCommand } from "./vault_create.ts";
import { vaultSearchCommand } from "./vault_search.ts";
import { vaultGetCommand } from "./vault_get.ts";
import { vaultEditCommand } from "./vault_edit.ts";
import { vaultPutCommand } from "./vault_put.ts";
import { vaultListKeysCommand } from "./vault_list_keys.ts";

/**
 * Parent command for vault type operations.
 */
export const vaultTypeCommand = new Command()
  .name("type")
  .description("Inspect vault types")
  .action(function () {
    this.showHelp();
  })
  .command("search", vaultTypeSearchCommand);

/**
 * Parent command for vault operations.
 */
export const vaultCommand = new Command()
  .name("vault")
  .description("Manage vault configurations")
  .action(function () {
    this.showHelp();
  })
  .command("type", vaultTypeCommand)
  .command("create", vaultCreateCommand)
  .command("search", vaultSearchCommand)
  .command("get", vaultGetCommand)
  .command("edit", vaultEditCommand)
  .command("put", vaultPutCommand)
  .command("list-keys", vaultListKeysCommand);
