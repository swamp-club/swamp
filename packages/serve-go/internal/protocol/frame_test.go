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

package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
)

type shortReader struct {
	r io.Reader
	n int
}

func (r shortReader) Read(p []byte) (int, error) {
	if len(p) > r.n {
		p = p[:r.n]
	}
	return r.r.Read(p)
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return w.Buffer.Write(p)
}

func TestSharedFixturesAcrossChunkBoundaries(t *testing.T) {
	raw, err := os.ReadFile("../../fixtures/frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []Envelope
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		frame, err := Encode(fixture)
		if err != nil {
			t.Fatal(err)
		}
		for chunk := 1; chunk < 17; chunk++ {
			actual, err := Read(shortReader{bytes.NewReader(frame), chunk})
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := Encode(actual)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(encoded, frame) {
				t.Fatalf("changed fixture at chunk %d", chunk)
			}
		}
		var w shortWriter
		if err := Write(&w, frame); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(w.Bytes(), frame) {
			t.Fatal("short write lost data")
		}
	}
}
func TestReadRejectsMalformedAndTruncatedFrames(t *testing.T) {
	frame, _ := Encode(Envelope{Version: Version, Generation: "a", ID: "b", Result: json.RawMessage(`{}`)})
	for n := 1; n < len(frame); n++ {
		if _, err := Read(bytes.NewReader(frame[:n])); err == nil {
			t.Fatalf("accepted truncation %d", n)
		}
	}
	for _, body := range [][]byte{[]byte(`not json`), []byte(`{"version":2,"generation":"a","id":"b"}`), []byte(`{"version":1,"generation":"a"}`), {0xff}} {
		var b bytes.Buffer
		_ = binary.Write(&b, binary.BigEndian, uint32(len(body)))
		b.Write(body)
		if _, err := Read(&b); err == nil {
			t.Fatal("accepted malformed frame")
		}
	}
	for _, n := range []uint32{0, MaxFrameBytes + 1, 0xffffffff} {
		var b bytes.Buffer
		_ = binary.Write(&b, binary.BigEndian, n)
		if _, err := Read(&b); !errors.Is(err, ErrFrame) {
			t.Fatalf("bad length returned %v", err)
		}
	}
	if _, err := Read(bytes.NewReader(nil)); !errors.Is(err, io.EOF) {
		t.Fatalf("clean EOF: %v", err)
	}
}
func TestManifestLimit(t *testing.T) {
	raw, err := os.ReadFile("../../protocol.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version int `json:"version"`
		Limits  struct {
			FrameBytes int `json:"frameBytes"`
		} `json:"limits"`
	}
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != Version || manifest.Limits.FrameBytes != MaxFrameBytes {
		t.Fatal("Go protocol differs from authoritative manifest")
	}
}
func FuzzFrameRoundTrip(f *testing.F) {
	f.Add("héllo 🌿", uint8(1))
	f.Fuzz(func(t *testing.T, value string, chunk uint8) {
		if len(value) > 1024*1024 {
			return
		}
		payload, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := Encode(Envelope{Version: Version, Generation: "g", ID: "i", Result: payload})
		if err != nil {
			t.Fatal(err)
		}
		got, err := Read(shortReader{bytes.NewReader(frame), int(chunk) + 1})
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got.Result, payload) {
			t.Fatal("roundtrip changed payload")
		}
	})
}
