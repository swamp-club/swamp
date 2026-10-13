// c-shared Litestream wrapper for the swamp-club#3234 spike (option b).
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"time"
	"unsafe"

	"github.com/benbjohnson/litestream"
	"github.com/benbjohnson/litestream/file"
	_ "github.com/benbjohnson/litestream/gs"
	_ "github.com/benbjohnson/litestream/s3"
)

var store *litestream.Store
var db *litestream.DB

//export LsOpen
func LsOpen(dbPath *C.char, replicaPath *C.char) C.int {
	db = litestream.NewDB(C.GoString(dbPath))
	client := file.NewReplicaClient(C.GoString(replicaPath))
	r := litestream.NewReplicaWithClient(db, client)
	db.Replica = r
	client.Replica = r
	store = litestream.NewStore([]*litestream.DB{db}, litestream.CompactionLevels{{Level: 0}, {Level: 1, Interval: 10 * time.Second}})
	if err := store.Open(context.Background()); err != nil {
		return 1
	}
	return 0
}

//export LsSync
func LsSync() *C.char {
	res, err := store.SyncDB(context.Background(), db.Path(), true)
	out := map[string]any{"txid": res.TXID, "replicated_txid": res.ReplicatedTXID}
	if err != nil {
		out["error"] = err.Error()
	}
	b, _ := json.Marshal(out)
	return C.CString(string(b))
}

//export LsFree
func LsFree(p *C.char) { C.free(unsafe.Pointer(p)) }

//export LsClose
func LsClose() C.int {
	if err := store.Close(context.Background()); err != nil {
		return 1
	}
	return 0
}

func main() {}
