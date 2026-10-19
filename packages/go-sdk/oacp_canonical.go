package grantex

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// JSON Canonicalization Scheme (RFC 8785) for OACP artifacts.
//
// The JSON text is parsed by a token-stream parser of its own rather than
// encoding/json, so that repeated member names, unpaired surrogates and
// number spellings are seen exactly as written. Canonicalization then sorts
// object members by the UTF-16 code units of their names, writes no
// insignificant whitespace, escapes strings as RFC 8785 requires and writes
// numbers in the ECMAScript Number::toString form. Anything without a single
// canonical form (NaN or infinite numbers, unpaired surrogates, invalid
// UTF-8, nesting deeper than oacpCanonicalMaxDepth) is refused.
//
// The rules and the shared fixtures are in spec/canonicalization.md and
// spec/examples/canonicalization/.

// oacpCanonicalMaxDepth is the deepest nesting of arrays and objects that
// has a canonical form.
const oacpCanonicalMaxDepth = 64

// oacpParseMaxDepth bounds the parser's recursion. It is deliberately larger
// than oacpCanonicalMaxDepth: a value nested between the two parses and is
// then refused by the canonicalizer, as it is by the other SDKs.
const oacpParseMaxDepth = 10000

// errOacpCanonical marks a value with no RFC 8785 canonical form.
var errOacpCanonical = errors.New("grantex: value has no RFC 8785 canonical form")

// oacpObject is a parsed JSON object: member names in document order and
// their values.
type oacpObject struct {
	keys    []string
	members map[string]any
}

func (o *oacpObject) get(key string) (any, bool) {
	v, ok := o.members[key]
	return v, ok
}

// oacpNumber is a parsed JSON number. value is the nearest double, and may
// be infinite when the text overflows one; such a number has no canonical
// form.
type oacpNumber struct {
	text  string
	value float64
}

// oacpJSONError is a JSON text that cannot be parsed.
type oacpJSONError struct {
	pos int
	msg string
}

func (e *oacpJSONError) Error() string {
	return fmt.Sprintf("grantex: invalid JSON at byte %d: %s", e.pos, e.msg)
}

// oacpDuplicateKeyError is a JSON text repeating a member name within one
// object.
type oacpDuplicateKeyError struct {
	key string
}

func (e *oacpDuplicateKeyError) Error() string {
	return fmt.Sprintf("grantex: duplicate member name %q", e.key)
}

type oacpParser struct {
	data     []byte
	pos      int
	lastWins bool
}

// parseOacpJSON parses one JSON text. Values are nil, bool, string,
// oacpNumber, []any and *oacpObject. A repeated member name is an error
// unless lastWins is set, in which case the last value is kept (the
// behaviour of JSON.parse). Strings keep unpaired surrogate escapes as
// WTF-8 bytes, so they parse but have no canonical form; raw bytes must be
// valid UTF-8.
func parseOacpJSON(data []byte, lastWins bool) (any, error) {
	p := &oacpParser{data: data, lastWins: lastWins}
	p.skipSpace()
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.pos != len(p.data) {
		return nil, p.fail("unexpected data after the JSON value")
	}
	return v, nil
}

func (p *oacpParser) fail(msg string) error {
	return &oacpJSONError{pos: p.pos, msg: msg}
}

func (p *oacpParser) skipSpace() {
	for p.pos < len(p.data) {
		switch p.data[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *oacpParser) value(depth int) (any, error) {
	if p.pos >= len(p.data) {
		return nil, p.fail("unexpected end of input")
	}
	switch c := p.data[p.pos]; {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.array(depth)
	case c == '"':
		return p.str()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case p.literal("true"):
		return true, nil
	case p.literal("false"):
		return false, nil
	case p.literal("null"):
		return nil, nil
	default:
		return nil, p.fail("unexpected character")
	}
}

func (p *oacpParser) literal(word string) bool {
	if bytes.HasPrefix(p.data[p.pos:], []byte(word)) {
		p.pos += len(word)
		return true
	}
	return false
}

func (p *oacpParser) object(depth int) (any, error) {
	if depth >= oacpParseMaxDepth {
		return nil, p.fail("nesting too deep")
	}
	p.pos++ // {
	obj := &oacpObject{members: map[string]any{}}
	p.skipSpace()
	if p.pos < len(p.data) && p.data[p.pos] == '}' {
		p.pos++
		return obj, nil
	}
	for {
		p.skipSpace()
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return nil, p.fail("expected a member name")
		}
		key, err := p.str()
		if err != nil {
			return nil, err
		}
		p.skipSpace()
		if p.pos >= len(p.data) || p.data[p.pos] != ':' {
			return nil, p.fail("expected ':'")
		}
		p.pos++
		p.skipSpace()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		if _, dup := obj.members[key]; dup {
			if !p.lastWins {
				return nil, &oacpDuplicateKeyError{key: key}
			}
		} else {
			obj.keys = append(obj.keys, key)
		}
		obj.members[key] = v
		p.skipSpace()
		if p.pos >= len(p.data) {
			return nil, p.fail("unexpected end of input")
		}
		switch p.data[p.pos] {
		case ',':
			p.pos++
		case '}':
			p.pos++
			return obj, nil
		default:
			return nil, p.fail("expected ',' or '}'")
		}
	}
}

func (p *oacpParser) array(depth int) (any, error) {
	if depth >= oacpParseMaxDepth {
		return nil, p.fail("nesting too deep")
	}
	p.pos++ // [
	arr := []any{}
	p.skipSpace()
	if p.pos < len(p.data) && p.data[p.pos] == ']' {
		p.pos++
		return arr, nil
	}
	for {
		p.skipSpace()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		arr = append(arr, v)
		p.skipSpace()
		if p.pos >= len(p.data) {
			return nil, p.fail("unexpected end of input")
		}
		switch p.data[p.pos] {
		case ',':
			p.pos++
		case ']':
			p.pos++
			return arr, nil
		default:
			return nil, p.fail("expected ',' or ']'")
		}
	}
}

func (p *oacpParser) hex4() (rune, bool) {
	if p.pos+4 > len(p.data) {
		return 0, false
	}
	v, err := strconv.ParseUint(string(p.data[p.pos:p.pos+4]), 16, 32)
	if err != nil {
		return 0, false
	}
	p.pos += 4
	return rune(v), true
}

// appendWTF8 encodes a surrogate code unit the way WTF-8 does. The bytes are
// not valid UTF-8, so the string has no canonical form.
func appendWTF8(b []byte, cu rune) []byte {
	return append(b, byte(0xE0|(cu>>12)), byte(0x80|((cu>>6)&0x3F)), byte(0x80|(cu&0x3F)))
}

func (p *oacpParser) str() (string, error) {
	p.pos++ // opening quote
	var b []byte
	for {
		if p.pos >= len(p.data) {
			return "", p.fail("unterminated string")
		}
		c := p.data[p.pos]
		switch {
		case c == '"':
			p.pos++
			return string(b), nil
		case c < 0x20:
			return "", p.fail("control character in string")
		case c == '\\':
			p.pos++
			if p.pos >= len(p.data) {
				return "", p.fail("unterminated escape")
			}
			e := p.data[p.pos]
			p.pos++
			switch e {
			case '"', '\\', '/':
				b = append(b, e)
			case 'b':
				b = append(b, '\b')
			case 'f':
				b = append(b, '\f')
			case 'n':
				b = append(b, '\n')
			case 'r':
				b = append(b, '\r')
			case 't':
				b = append(b, '\t')
			case 'u':
				cu, ok := p.hex4()
				if !ok {
					return "", p.fail("invalid \\u escape")
				}
				if utf16.IsSurrogate(cu) {
					if cu < 0xDC00 && p.pos+6 <= len(p.data) && p.data[p.pos] == '\\' && p.data[p.pos+1] == 'u' {
						save := p.pos
						p.pos += 2
						lo, ok := p.hex4()
						if ok && lo >= 0xDC00 && lo <= 0xDFFF {
							b = utf8.AppendRune(b, utf16.DecodeRune(cu, lo))
							continue
						}
						p.pos = save
					}
					b = appendWTF8(b, cu)
					continue
				}
				b = utf8.AppendRune(b, cu)
			default:
				return "", p.fail("invalid escape")
			}
		case c < utf8.RuneSelf:
			b = append(b, c)
			p.pos++
		default:
			r, size := utf8.DecodeRune(p.data[p.pos:])
			if r == utf8.RuneError && size <= 1 {
				return "", p.fail("invalid UTF-8")
			}
			b = append(b, p.data[p.pos:p.pos+size]...)
			p.pos += size
		}
	}
}

func (p *oacpParser) digits() int {
	start := p.pos
	for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
		p.pos++
	}
	return p.pos - start
}

func (p *oacpParser) number() (any, error) {
	start := p.pos
	if p.data[p.pos] == '-' {
		p.pos++
	}
	if p.pos < len(p.data) && p.data[p.pos] == '0' {
		p.pos++
	} else if p.digits() == 0 {
		return nil, p.fail("invalid number")
	}
	if p.pos < len(p.data) && p.data[p.pos] == '.' {
		p.pos++
		if p.digits() == 0 {
			return nil, p.fail("invalid number")
		}
	}
	if p.pos < len(p.data) && (p.data[p.pos] == 'e' || p.data[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.data) && (p.data[p.pos] == '+' || p.data[p.pos] == '-') {
			p.pos++
		}
		if p.digits() == 0 {
			return nil, p.fail("invalid number")
		}
	}
	text := string(p.data[start:p.pos])
	// ParseFloat rounds to nearest like JSON.parse; on overflow it returns an
	// infinity with ErrRange, which the canonicalizer refuses.
	v, err := strconv.ParseFloat(text, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, p.fail("invalid number")
	}
	return oacpNumber{text: text, value: v}, nil
}

// canonicalizeOacpJSON parses a JSON text, refusing repeated member names,
// and returns its RFC 8785 canonical form.
func canonicalizeOacpJSON(data []byte) ([]byte, error) {
	v, err := parseOacpJSON(data, false)
	if err != nil {
		return nil, err
	}
	return canonicalizeOacpValue(v)
}

// canonicalizeOacpValue returns the RFC 8785 canonical form of a parsed value.
func canonicalizeOacpValue(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeOacpCanonical(&buf, v, 0); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeOacpCanonical(buf *bytes.Buffer, v any, depth int) error {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case oacpNumber:
		s, err := formatOacpNumber(t.value)
		if err != nil {
			return err
		}
		buf.WriteString(s)
	case string:
		return writeOacpString(buf, t)
	case []any:
		if depth >= oacpCanonicalMaxDepth {
			return fmt.Errorf("%w: nesting deeper than %d levels", errOacpCanonical, oacpCanonicalMaxDepth)
		}
		buf.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeOacpCanonical(buf, item, depth+1); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case *oacpObject:
		if depth >= oacpCanonicalMaxDepth {
			return fmt.Errorf("%w: nesting deeper than %d levels", errOacpCanonical, oacpCanonicalMaxDepth)
		}
		keys := sortedUTF16Keys(t.keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeOacpString(buf, k); err != nil {
				return err
			}
			buf.WriteByte(':')
			if err := writeOacpCanonical(buf, t.members[k], depth+1); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("%w: unsupported value of type %T", errOacpCanonical, v)
	}
	return nil
}

// sortedUTF16Keys orders member names by their UTF-16 code units, as
// RFC 8785 section 3.2.3 requires (this differs from byte order for names
// with characters above U+FFFF).
func sortedUTF16Keys(keys []string) []string {
	type entry struct {
		key   string
		units []uint16
	}
	entries := make([]entry, len(keys))
	for i, k := range keys {
		entries[i] = entry{key: k, units: utf16.Encode([]rune(k))}
	}
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i].units, entries[j].units
		for n := 0; n < len(a) && n < len(b); n++ {
			if a[n] != b[n] {
				return a[n] < b[n]
			}
		}
		return len(a) < len(b)
	})
	out := make([]string, len(keys))
	for i, e := range entries {
		out[i] = e.key
	}
	return out
}

const oacpHexDigits = "0123456789abcdef"

// writeOacpString writes a string as RFC 8785 section 3.2.2.2 does: only
// '"', '\' and the C0 controls are escaped, with the short escapes where
// they exist and \u00xx otherwise. No HTML escaping; U+2028 and U+2029 are
// written as they are.
func writeOacpString(buf *bytes.Buffer, s string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("%w: string contains an unpaired surrogate or invalid UTF-8", errOacpCanonical)
	}
	buf.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			buf.WriteString(`\"`)
		case c == '\\':
			buf.WriteString(`\\`)
		case c == '\b':
			buf.WriteString(`\b`)
		case c == '\t':
			buf.WriteString(`\t`)
		case c == '\n':
			buf.WriteString(`\n`)
		case c == '\f':
			buf.WriteString(`\f`)
		case c == '\r':
			buf.WriteString(`\r`)
		case c < 0x20:
			buf.WriteString(`\u00`)
			buf.WriteByte(oacpHexDigits[c>>4])
			buf.WriteByte(oacpHexDigits[c&0xF])
		default:
			buf.WriteByte(c)
		}
	}
	buf.WriteByte('"')
	return nil
}

// formatOacpNumber writes a finite double as ECMAScript Number::toString
// does (ECMA-262 Number::toString, radix 10): the shortest digits that
// round-trip, plain notation for 1e-6 <= |x| < 1e21 and exponent notation
// otherwise. -0 is written as 0.
func formatOacpNumber(v float64) (string, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "", fmt.Errorf("%w: NaN and infinite numbers have no JSON form", errOacpCanonical)
	}
	if v == 0 {
		return "0", nil
	}
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	// Shortest round-trip digits in the form d.ddde±x.
	e := strconv.FormatFloat(v, 'e', -1, 64)
	mant, expText, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, err := strconv.Atoi(expText)
	if err != nil {
		return "", fmt.Errorf("%w: unexpected float format %q", errOacpCanonical, e)
	}
	k := len(digits)
	n := exp + 1 // the decimal point sits after n digits
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		expSign := "+"
		if e < 0 {
			expSign = "-"
			e = -e
		}
		if k == 1 {
			out = digits + "e" + expSign + strconv.Itoa(e)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(e)
		}
	}
	return sign + out, nil
}
