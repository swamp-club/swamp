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

//go:build linux || darwin

package engine

import (
	"errors"
	"io"
	"net"
	"os"
	"testing"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
)

func testFence(t *testing.T) *unixFence {
	t.Helper()
	fence, err := newProcessFence(time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	f := fence.(*unixFence)
	t.Cleanup(f.Close)
	return f
}
func registerGuardian(t *testing.T, f *unixFence) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("unix", f.Path(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	deadline, _ := testContext(t).Deadline()
	_ = conn.SetDeadline(deadline)
	if _, err = conn.Write([]byte{'R'}); err != nil {
		t.Fatal(err)
	}
	var response [1]byte
	if _, err = io.ReadFull(conn, response[:]); err != nil || response[0] != 'A' {
		t.Fatalf("registration: %q %v", response, err)
	}
	return conn
}
func readFenceByte(t *testing.T, conn net.Conn, want byte) {
	t.Helper()
	var response [1]byte
	if _, err := io.ReadFull(conn, response[:]); err != nil || response[0] != want {
		t.Fatalf("fence response: %q, want %q: %v", response, want, err)
	}
}
func fenceResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-testContext(t).Done():
		t.Fatal("cleanup proof did not settle")
		return nil
	}
}
func TestCommandFenceWaitsForCleanupBeforeReleasingGeneration(t *testing.T) {
	f := testFence(t)
	info, err := os.Stat(f.directory)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("private fence directory: %v %v", info, err)
	}
	conn := registerGuardian(t, f)
	finished := make(chan error, 1)
	go func() { finished <- f.SealAndWait() }()
	readFenceByte(t, conn, 'K')
	select {
	case err := <-finished:
		t.Fatalf("reaped without command cleanup: %v", err)
	default:
	}
	if _, err := conn.Write([]byte{'C'}); err != nil {
		t.Fatal(err)
	}
	if err := fenceResult(t, finished); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(f.directory); !os.IsNotExist(err) {
		t.Fatalf("fence path leaked: %v", err)
	}
	if _, err := net.DialTimeout("unix", f.Path(), time.Second); err == nil {
		t.Fatal("sealed generation still admits commands")
	}
}
func TestCommandFenceMissingCleanupIsStickyAndSignalsLiveEngine(t *testing.T) {
	f := testFence(t)
	conn := registerGuardian(t, f)
	_ = conn.Close()
	select {
	case <-f.Failed():
	case <-testContext(t).Done():
		t.Fatal("lost guardian did not fence engine")
	}
	if err := f.SealAndWait(); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
		t.Fatalf("lost cleanup was hidden: %v", err)
	}
}
func TestCommandFenceDeadlineClosesUnresponsiveGuardian(t *testing.T) {
	f := testFence(t)
	conn := registerGuardian(t, f)
	finished := make(chan error, 1)
	go func() { finished <- f.SealAndWait() }()
	readFenceByte(t, conn, 'K')
	f.SetDeadline(time.Time{})
	if err := fenceResult(t, finished); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
		t.Fatalf("deadline claimed cleanup: %v", err)
	}
}
func TestCommandFenceBoundsRegistrationsAndReleasesCompletedSlots(t *testing.T) {
	f := testFence(t)
	guardians := make([]net.Conn, servecontract.MaxCommandGuardians())
	for i := range guardians {
		guardians[i] = registerGuardian(t, f)
	}
	extra, err := net.DialTimeout("unix", f.Path(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	deadline, _ := testContext(t).Deadline()
	_ = extra.SetDeadline(deadline)
	var response [1]byte
	if _, err := extra.Read(response[:]); err == nil {
		t.Fatal("over-capacity guardian admitted")
	}
	for _, conn := range guardians {
		if _, err := conn.Write([]byte{'C'}); err != nil {
			t.Fatal(err)
		}
	}
	f.mu.Lock()
	for len(f.connections) != 0 {
		changed := f.changed
		f.mu.Unlock()
		select {
		case <-changed:
		case <-testContext(t).Done():
			t.Fatal("completed guardian slots retained")
		}
		f.mu.Lock()
	}
	f.mu.Unlock()
	replacement := registerGuardian(t, f)
	_, _ = replacement.Write([]byte{'C'})
	if err := f.SealAndWait(); err != nil {
		t.Fatal(err)
	}
}
func TestCommandFenceSealRefusesIncompleteHandshake(t *testing.T) {
	f := testFence(t)
	conn, err := net.DialTimeout("unix", f.Path(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// A socket without R is never allowed to spawn a target and need not C.
	if err := f.SealAndWait(); err != nil {
		t.Fatal(err)
	}
	var response [1]byte
	if _, err := conn.Read(response[:]); err == nil {
		t.Fatal("incomplete registration survived sealing")
	}
}
