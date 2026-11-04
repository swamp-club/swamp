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
	"os"
	"os/exec"
	"reflect"
	"testing"
)

func TestConfigureProtocolPipesUsesPrivateDescriptors(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	cmd := exec.Command("unused-engine")
	prepareProcess(cmd)
	args, err := configureProtocolPipes(cmd, reader, writer)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(args, []string{"--input-fd", "3", "--output-fd", "4"}) {
		t.Fatalf("unexpected protocol args %v", args)
	}
	if !reflect.DeepEqual(cmd.ExtraFiles, []*os.File{reader, writer}) {
		t.Fatal("private input and output must occupy inherited descriptors 3 and 4")
	}
	if cmd.Stdin != nil || cmd.Stdout != nil || cmd.Stderr != nil {
		t.Fatal("all ordinary standard streams must use the null device")
	}
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("process group containment must remain enabled")
	}
}

func TestConfigureProtocolPipesPreservesExistingDescriptors(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	cmd := exec.Command("unused-engine")
	cmd.ExtraFiles = []*os.File{os.Stderr}
	args, err := configureProtocolPipes(cmd, reader, writer)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(args, []string{"--input-fd", "4", "--output-fd", "5"}) || !reflect.DeepEqual(cmd.ExtraFiles, []*os.File{os.Stderr, reader, writer}) {
		t.Fatalf("existing inherited descriptors were overwritten: %v %v", args, cmd.ExtraFiles)
	}
}
