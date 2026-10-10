// Child writer for exp_crash C: commits in a tight loop until killed.
import * as L from "./lib.ts";
const db = L.openWriter(Deno.args[0], { appAutoCheckpoint: 1000 });
while (true) {
  db.exec("BEGIN");
  for (let i = 0; i < 20; i++) L.insertCommit(db, 1024);
  db.exec("COMMIT");
}
