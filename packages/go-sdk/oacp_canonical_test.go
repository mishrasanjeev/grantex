package grantex

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const canonicalFixtures = "../../spec/examples/canonicalization"

func TestOacpCanonicalParityFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(canonicalFixtures, "parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Valid []struct {
			Name      string `json:"name"`
			Input     string `json:"input"`
			Canonical string `json:"canonical"`
		} `json:"valid"`
		Invalid []struct {
			Name  string `json:"name"`
			Input string `json:"input"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures.Valid) == 0 || len(fixtures.Invalid) == 0 {
		t.Fatal("parity fixtures are empty")
	}
	for _, c := range fixtures.Valid {
		t.Run("valid/"+c.Name, func(t *testing.T) {
			got, err := canonicalizeOacpJSON([]byte(c.Input))
			if err != nil {
				t.Fatalf("canonicalize: %v", err)
			}
			if string(got) != c.Canonical {
				t.Fatalf("got %s\nwant %s", got, c.Canonical)
			}
		})
	}
	for _, c := range fixtures.Invalid {
		t.Run("invalid/"+c.Name, func(t *testing.T) {
			if got, err := canonicalizeOacpJSON([]byte(c.Input)); err == nil {
				t.Fatalf("expected a refusal, got %s", got)
			}
		})
	}
}

func TestOacpCanonicalRFC8785Vectors(t *testing.T) {
	inputs, err := filepath.Glob(filepath.Join(canonicalFixtures, "rfc8785", "input", "*.json"))
	if err != nil || len(inputs) == 0 {
		t.Fatalf("no RFC 8785 vectors: %v", err)
	}
	for _, in := range inputs {
		name := filepath.Base(in)
		t.Run(name, func(t *testing.T) {
			input, err := os.ReadFile(in)
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(filepath.Join(canonicalFixtures, "rfc8785", "output", name))
			if err != nil {
				t.Fatal(err)
			}
			got, err := canonicalizeOacpJSON(input)
			if err != nil {
				t.Fatalf("canonicalize: %v", err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("got  %s\nwant %s", got, want)
			}
			hexWant, err := os.ReadFile(filepath.Join(canonicalFixtures, "rfc8785", "outhex", strings.TrimSuffix(name, ".json")+".txt"))
			if err != nil {
				t.Fatal(err)
			}
			wantBytes, err := hex.DecodeString(strings.Join(strings.Fields(string(hexWant)), ""))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, wantBytes) {
				t.Fatalf("outhex mismatch for %s", name)
			}
		})
	}
}

// TestOacpCanonicalES6Numbers runs the RFC 8785 ES6 number serialisation
// test described in es6-numbers.json and compares the checksums.
func TestOacpCanonicalES6Numbers(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(canonicalFixtures, "es6-numbers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		StaticU64   []string `json:"static_u64"`
		SerialCount int      `json:"serial_count"`
		Checksums   []struct {
			Lines  int    `json:"lines"`
			Bytes  int    `json:"bytes"`
			SHA256 string `json:"sha256"`
		} `json:"checksums"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	maxLines := 0
	for _, c := range spec.Checksums {
		if c.Lines > maxLines {
			maxLines = c.Lines
		}
	}
	values := make([]uint64, 0, maxLines)
	for _, s := range spec.StaticU64 {
		var v uint64
		if _, err := fmt.Sscanf(s, "%x", &v); err != nil {
			t.Fatal(err)
		}
		values = append(values, v)
	}
	for i := 0; i < spec.SerialCount; i++ {
		values = append(values, 0x0010000000000000+uint64(i))
	}
	block := make([]byte, 32)
	for len(values) < maxLines {
		sum := sha256.Sum256(block)
		block = sum[:]
		for i := 0; i < 4; i++ {
			bits := binary.LittleEndian.Uint64(block[i*8:])
			f := math.Float64frombits(bits)
			if f == 0 || math.IsNaN(f) || math.IsInf(f, 0) {
				continue
			}
			values = append(values, bits)
		}
	}
	var out bytes.Buffer
	lines := 0
	for _, bits := range values {
		s, err := formatOacpNumber(math.Float64frombits(bits))
		if err != nil {
			t.Fatalf("%x: %v", bits, err)
		}
		fmt.Fprintf(&out, "%x,%s\n", bits, s)
		lines++
		for _, c := range spec.Checksums {
			if c.Lines == lines {
				sum := sha256.Sum256(out.Bytes())
				if out.Len() != c.Bytes || hex.EncodeToString(sum[:]) != c.SHA256 {
					t.Fatalf("checksum for %d lines: got %d bytes %x, want %d bytes %s", lines, out.Len(), sum, c.Bytes, c.SHA256)
				}
			}
		}
		if lines == maxLines {
			break
		}
	}
}

func TestOacpCanonicalRules(t *testing.T) {
	cases := []struct {
		name, input, want string
	}{
		{"no HTML escaping", `"</script> & <b>"`, `"</script> & <b>"`},
		{"U+2028 and U+2029 literal", "\"\\u2028\\u2029\"", "\"  \""},
		{"lowercase hex escapes", `"\u001F\u000B"`, `"\u001f\u000b"`},
		{"short escapes", `"\b\t\n\f\r"`, `"\b\t\n\f\r"`},
		{"DEL is not escaped", `"\u007f"`, "\"\x7f\""},
		{"surrogate pair combined", `"😀"`, "\"\U0001F600\""},
		{"exponent forms", `[1e-7, 1.5e-7, 1e21, 1.5e21, 123e-20, -1e-7]`, `[1e-7,1.5e-7,1e+21,1.5e+21,1.23e-18,-1e-7]`},
		{"plain forms", `[0.000001, 1.5e20, 1e20, 0.1, -12.5]`, `[0.000001,150000000000000000000,100000000000000000000,0.1,-12.5]`},
		{"underflow is zero", `1e-400`, `0`},
		{"negative zero", `-0`, `0`},
		{"members sorted by code unit", `{"b":1,"a":2,"aa":3,"A":4}`, `{"A":4,"a":2,"aa":3,"b":1}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := canonicalizeOacpJSON([]byte(c.input))
			if err != nil {
				t.Fatalf("canonicalize: %v", err)
			}
			if string(got) != c.want {
				t.Fatalf("got %s want %s", got, c.want)
			}
		})
	}

	refused := []struct{ name, input string }{
		{"duplicate member", `{"a":1,"a":2}`},
		{"duplicate member after unescaping", `{"a":1,"a":2}`},
		{"lone high surrogate", `"\uD800"`},
		{"lone low surrogate", `"\uDC00x"`},
		{"reversed surrogates", `"\uDE00\uD83D"`},
		{"invalid UTF-8", "\"\xff\""},
		{"encoded surrogate bytes", "\"\xed\xa0\x80\""},
		{"overflow", `1e309`},
		{"raw control character", "\"a\x01\""},
		{"trailing comma", `[1,]`},
		{"leading zero", `01`},
		{"bad literal", `nul`},
		{"trailing data", `{} {}`},
		{"single quotes", `'a'`},
		{"bad escape", `"\x"`},
	}
	for _, c := range refused {
		t.Run("refuses "+c.name, func(t *testing.T) {
			if got, err := canonicalizeOacpJSON([]byte(c.input)); err == nil {
				t.Fatalf("expected a refusal, got %s", got)
			}
		})
	}

	t.Run("depth limit", func(t *testing.T) {
		ok := strings.Repeat("[", oacpCanonicalMaxDepth) + strings.Repeat("]", oacpCanonicalMaxDepth)
		if _, err := canonicalizeOacpJSON([]byte(ok)); err != nil {
			t.Fatalf("depth %d refused: %v", oacpCanonicalMaxDepth, err)
		}
		deep := strings.Repeat(`{"a":`, oacpCanonicalMaxDepth+1) + "1" + strings.Repeat("}", oacpCanonicalMaxDepth+1)
		_, err := canonicalizeOacpJSON([]byte(deep))
		if !errors.Is(err, errOacpCanonical) {
			t.Fatalf("depth %d: got %v, want a canonical-form refusal", oacpCanonicalMaxDepth+1, err)
		}
	})

	t.Run("duplicate keys kept last when asked", func(t *testing.T) {
		v, err := parseOacpJSON([]byte(`{"a":1,"a":2}`), true)
		if err != nil {
			t.Fatal(err)
		}
		got, err := canonicalizeOacpValue(v)
		if err != nil || string(got) != `{"a":2}` {
			t.Fatalf("got %s, %v", got, err)
		}
	})
}
