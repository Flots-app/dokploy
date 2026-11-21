package provider

import (
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strings"

	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// Kind is the Terraform type of a field.
type Kind int

const (
	// String is a Terraform string.
	String Kind = iota
	// Bool is a Terraform bool.
	Bool
	// Int is a Terraform number holding an integer.
	Int
	// StringList is an ordered list of strings.
	StringList
	// StringSet is an unordered set of strings.
	StringSet
	// StringMap is a map of strings.
	StringMap
	// JSON is an arbitrary JSON value, exposed as a string. Use jsonencode()
	// in configurations; the provider normalizes what the API returns.
	JSON
)

// Field describes one attribute of a resource and how it maps to the API.
//
// Unless Required or ReadOnly, a field is Optional and Computed: an attribute
// left out of the configuration adopts the value the API reports, so existing
// objects can be imported without having to spell out every default.
type Field struct {
	// Name is the Terraform attribute name (snake_case).
	Name string
	// API is the JSON key; defaults to the lowerCamelCase of Name.
	API  string
	Kind Kind
	Desc string

	// Required makes the attribute mandatory.
	Required bool
	// ReadOnly makes the attribute computed only.
	ReadOnly bool
	// ForceNew replaces the resource when the attribute changes.
	ForceNew bool
	// Sensitive redacts the value in plans. Secrets should rather be WriteOnly.
	Sensitive bool
	// WriteOnly values are sent to the API when set in the configuration, and
	// never stored in the plan or the state (Terraform 1.11+). Bump the
	// resource's secrets_version to send them again without any other change.
	WriteOnly bool
	// Volatile marks a computed value that can change on its own (a status):
	// it is not carried over from the prior state.
	Volatile bool
	// Opaque is for free text that may hold secrets (an inline compose file, a
	// file mount). The attribute is Optional only: it is managed when the
	// configuration declares it, and when it does not, the value Dokploy holds
	// is never copied into the state. Importing therefore never leaks it.
	Opaque bool
	// OneOf restricts string values.
	OneOf []string
	// Default is used on create when the attribute is left out. Only for
	// Optional+Computed fields whose API default is unsuitable.
	Default any

	// ToAPI converts the Terraform value (string, bool, int64, []any,
	// map[string]any, or decoded JSON) to the value sent to the API.
	ToAPI func(any) any
	// FromAPI converts the value the API returns to the Terraform value.
	FromAPI func(any) any
}

func (f Field) apiKey() string {
	if f.API != "" {
		return f.API
	}
	return camel(f.Name)
}

func (f Field) computed() bool { return f.ReadOnly || (!f.Required && !f.WriteOnly && !f.Opaque) }

func camel(snake string) string {
	parts := strings.Split(snake, "_")
	for i := 1; i < len(parts); i++ {
		if parts[i] == "" {
			continue
		}
		parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
	}
	return strings.Join(parts, "")
}

func tfType(k Kind) tftypes.Type {
	switch k {
	case Bool:
		return tftypes.Bool
	case Int:
		return tftypes.Number
	case StringList:
		return tftypes.List{ElementType: tftypes.String}
	case StringSet:
		return tftypes.Set{ElementType: tftypes.String}
	case StringMap:
		return tftypes.Map{ElementType: tftypes.String}
	default:
		return tftypes.String
	}
}

// fromTF converts a known, non-null Terraform value to its Go form. ok is
// false for null and unknown values.
func fromTF(k Kind, v tftypes.Value) (out any, ok bool) {
	if v.IsNull() || !v.IsFullyKnown() {
		return nil, false
	}
	switch k {
	case String:
		var s string
		if v.As(&s) != nil {
			return nil, false
		}
		return s, true
	case Bool:
		var b bool
		if v.As(&b) != nil {
			return nil, false
		}
		return b, true
	case Int:
		var f big.Float
		if v.As(&f) != nil {
			return nil, false
		}
		i, _ := f.Int64()
		return i, true
	case StringList, StringSet:
		var l []tftypes.Value
		if v.As(&l) != nil {
			return nil, false
		}
		res := make([]any, 0, len(l))
		for _, e := range l {
			var s string
			if e.As(&s) != nil {
				return nil, false
			}
			res = append(res, s)
		}
		if k == StringSet {
			sort.Slice(res, func(i, j int) bool { return res[i].(string) < res[j].(string) })
		}
		return res, true
	case StringMap:
		var m map[string]tftypes.Value
		if v.As(&m) != nil {
			return nil, false
		}
		res := make(map[string]any, len(m))
		for key, e := range m {
			var s string
			if e.As(&s) != nil {
				return nil, false
			}
			res[key] = s
		}
		return res, true
	case JSON:
		var s string
		if v.As(&s) != nil {
			return nil, false
		}
		var decoded any
		if json.Unmarshal([]byte(s), &decoded) != nil {
			return nil, false
		}
		return decoded, true
	}
	return nil, false
}

// toTF converts a decoded JSON value to a Terraform value of kind k. Missing
// or null API values become null, except collections which become empty.
func toTF(k Kind, v any) tftypes.Value {
	t := tfType(k)
	switch k {
	case String:
		switch x := v.(type) {
		case nil:
			return tftypes.NewValue(t, nil)
		case string:
			return tftypes.NewValue(t, x)
		case float64:
			return tftypes.NewValue(t, formatNumber(x))
		case bool:
			return tftypes.NewValue(t, fmt.Sprint(x))
		default:
			return tftypes.NewValue(t, fmt.Sprint(x))
		}
	case Bool:
		if b, ok := v.(bool); ok {
			return tftypes.NewValue(t, b)
		}
		return tftypes.NewValue(t, nil)
	case Int:
		switch x := v.(type) {
		case float64:
			return tftypes.NewValue(t, new(big.Float).SetInt64(int64(x)))
		case int64:
			return tftypes.NewValue(t, new(big.Float).SetInt64(x))
		case int:
			return tftypes.NewValue(t, new(big.Float).SetInt64(int64(x)))
		case string:
			if f, _, err := big.ParseFloat(x, 10, 64, big.ToNearestEven); err == nil {
				i, _ := f.Int64()
				return tftypes.NewValue(t, new(big.Float).SetInt64(i))
			}
		}
		return tftypes.NewValue(t, nil)
	case StringList, StringSet:
		l, _ := v.([]any)
		vals := make([]tftypes.Value, 0, len(l))
		for _, e := range l {
			vals = append(vals, tftypes.NewValue(tftypes.String, fmt.Sprint(e)))
		}
		if k == StringSet {
			sort.Slice(vals, func(i, j int) bool {
				var a, b string
				_ = vals[i].As(&a)
				_ = vals[j].As(&b)
				return a < b
			})
		}
		return tftypes.NewValue(t, vals)
	case StringMap:
		m, _ := v.(map[string]any)
		vals := make(map[string]tftypes.Value, len(m))
		for key, e := range m {
			vals[key] = tftypes.NewValue(tftypes.String, fmt.Sprint(e))
		}
		return tftypes.NewValue(t, vals)
	case JSON:
		if v == nil {
			return tftypes.NewValue(t, nil)
		}
		if s, ok := v.(string); ok && !looksLikeJSON(s) {
			// A plain string stored in a JSON column.
			b, _ := json.Marshal(s)
			return tftypes.NewValue(t, string(b))
		}
		b, err := json.Marshal(v)
		if err != nil {
			return tftypes.NewValue(t, nil)
		}
		return tftypes.NewValue(t, string(b))
	}
	return tftypes.NewValue(t, nil)
}

func looksLikeJSON(s string) bool {
	s = strings.TrimSpace(s)
	return strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[")
}

func formatNumber(f float64) string {
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	return fmt.Sprint(f)
}

// unknownOf returns an unknown value of kind k.
func unknownOf(k Kind) tftypes.Value { return tftypes.NewValue(tfType(k), tftypes.UnknownValue) }

// nullOf returns a null value of kind k.
func nullOf(k Kind) tftypes.Value { return tftypes.NewValue(tfType(k), nil) }
