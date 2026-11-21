package provider

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Dokploy stores the environment of a service as one dotenv-style text. A
// Terraform state must not hold the secrets inside it, so the provider splits
// that text in two:
//
//   - public variables, declared in `env`, are managed and stored in the state;
//   - secret variables are only declared by name (`secret_env_keys`). Their
//     values stay in Dokploy: the provider copies them over verbatim whenever
//     it rewrites the text, and only changes one when `secret_env_wo` carries
//     a new value (a write-only attribute: it is never stored).
//
// Every variable of the service must be declared in one of the two places;
// an undeclared variable is removed on the next apply.

var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.\-]*$`)

// envEntry is one variable of an environment text.
type envEntry struct {
	Key string
	// Raw is the original text of the entry, quotes and continuation lines
	// included, so secret values are carried over byte for byte.
	Raw string
	// Value is everything after the first '=', unquoted nothing: it is the
	// literal text, which is what `env` values hold.
	Value string
}

// parseEnv splits an environment text into entries. Blank lines, comments and
// lines that are not KEY=VALUE are ignored. A later duplicate replaces an
// earlier one, as dotenv does. A value that opens a double or single quote
// and does not close it on the same line continues on the following lines.
func parseEnv(text string) []envEntry {
	text = strings.TrimPrefix(text, "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	byKey := map[string]int{}
	var out []envEntry
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		if rest, ok := strings.CutPrefix(key, "export"); ok && rest != "" && (rest[0] == ' ' || rest[0] == '\t') {
			key = strings.TrimSpace(rest)
		}
		if !envKeyPattern.MatchString(key) {
			continue
		}
		value := line[eq+1:]
		raw := line
		// A quote that is never closed does not swallow the following lines:
		// dotenv reads such a value up to the end of its line.
		if q := openQuote(value); q != 0 && !closesQuote(value, q) && closesLater(lines[i+1:], q) {
			for !closesQuote(value, q) && i+1 < len(lines) {
				i++
				value += "\n" + lines[i]
				raw += "\n" + lines[i]
			}
		}
		e := envEntry{Key: key, Raw: raw, Value: value}
		if idx, dup := byKey[key]; dup {
			out[idx] = e
			continue
		}
		byKey[key] = len(out)
		out = append(out, e)
	}
	return out
}

// openQuote returns the quote character if value starts a quoted string.
func openQuote(value string) byte {
	v := strings.TrimLeft(value, " \t")
	if v != "" && (v[0] == '"' || v[0] == '\'' || v[0] == '`') {
		return v[0]
	}
	return 0
}

// closesQuote reports whether the quote opened at the start of value is
// closed within it.
func closesQuote(value string, q byte) bool {
	v := strings.TrimLeft(value, " \t")[1:]
	for i := 0; i < len(v); i++ {
		if v[i] == '\\' && q == '"' {
			i++
			continue
		}
		if v[i] == q {
			return true
		}
	}
	return false
}

// closesLater reports whether one of the following lines contains the quote.
func closesLater(lines []string, q byte) bool {
	for _, l := range lines {
		if strings.IndexByte(l, q) >= 0 {
			return true
		}
	}
	return false
}

func envKeys(entries []envEntry) []string {
	keys := make([]string, 0, len(entries))
	for _, e := range entries {
		keys = append(keys, e.Key)
	}
	sort.Strings(keys)
	return keys
}

func envIndex(entries []envEntry) map[string]envEntry {
	m := make(map[string]envEntry, len(entries))
	for _, e := range entries {
		m[e.Key] = e
	}
	return m
}

// publicRawProblem explains why a public value, written as the literal text after
// the '=' of a dotenv line, would be read back differently by Dokploy, or "" when
// it is safe. Dokploy parses the text with dotenv: an unquoted '#' starts a
// comment, a line break ends the value, edge blanks are trimmed and a quote that
// is opened must be closed.
func publicRawProblem(v string) string {
	if v == "" {
		return ""
	}
	if v != strings.TrimSpace(v) {
		return "it starts or ends with a blank, which dotenv trims: quote it"
	}
	if q := openQuote(v); q != 0 {
		if len(v) < 2 || v[len(v)-1] != q || strings.Count(v, string(q)) != 2 {
			return "it opens a quote that is not closed at its end, or holds the quote twice inside"
		}
		return ""
	}
	if strings.ContainsAny(v, "#\r\n") {
		return "it contains '#' or a line break, which dotenv does not keep outside quotes: quote it, for example \"'text'\""
	}
	return ""
}

// quoteSecretValue returns the dotenv text that Dokploy parses back to exactly
// the given value. Secret values are values, not text: they are quoted as needed.
func quoteSecretValue(v string) (string, error) {
	if v == "" {
		return "", nil
	}
	plain := v == strings.TrimSpace(v) && !strings.ContainsAny(v, "#\r\n\"'`")
	if plain {
		return v, nil
	}
	for _, q := range []byte{'\'', '`', '"'} {
		if strings.IndexByte(v, q) >= 0 {
			continue
		}
		if q == '"' && strings.Contains(v, "\\") {
			continue // dotenv expands escapes inside double quotes
		}
		return string(q) + v + string(q), nil
	}
	return "", errors.New("the value holds all three quote characters (', \", `) and cannot be stored in a dotenv text")
}

// renderEnv builds the environment text to store: public variables from
// `public`, secret variables from `secretValues` when given, otherwise copied
// from `remote`. Entries are sorted by key so the output is deterministic.
func renderEnv(public map[string]string, secretKeys []string, secretValues map[string]string, remote []envEntry) (string, error) {
	remoteByKey := envIndex(remote)
	lines := map[string]string{}
	for k, v := range public {
		if !envKeyPattern.MatchString(k) {
			return "", fmt.Errorf("invalid environment variable name %q", k)
		}
		if why := publicRawProblem(v); why != "" {
			return "", fmt.Errorf("public variable %q: %s", k, why)
		}
		lines[k] = k + "=" + v
	}
	var missing []string
	for _, k := range secretKeys {
		if !envKeyPattern.MatchString(k) {
			return "", fmt.Errorf("invalid environment variable name %q in secret_env_keys", k)
		}
		if _, dup := lines[k]; dup {
			return "", fmt.Errorf("variable %q is declared both in env and in secret_env_keys", k)
		}
		if v, ok := secretValues[k]; ok {
			quoted, err := quoteSecretValue(v)
			if err != nil {
				return "", fmt.Errorf("secret variable %q: %w", k, err)
			}
			lines[k] = k + "=" + quoted
			continue
		}
		if e, ok := remoteByKey[k]; ok {
			lines[k] = e.Raw
			continue
		}
		missing = append(missing, k)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return "", fmt.Errorf("secret variables %s have no value in Dokploy: provide them with secret_env_wo and bump secret_env_wo_version", strings.Join(missing, ", "))
	}
	for k := range secretValues {
		if _, ok := lines[k]; !ok {
			return "", fmt.Errorf("secret_env_wo sets %q, which is not listed in secret_env_keys", k)
		}
	}
	keys := make([]string, 0, len(lines))
	for k := range lines {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(lines[k])
		b.WriteByte('\n')
	}
	text := b.String()
	// The text must read back as exactly the declared variables: a value that
	// slipped a line break or an unclosed quote through would add or swallow one.
	got := envKeys(parseEnv(text))
	if len(got) != len(keys) {
		return "", fmt.Errorf("the environment text would read back with %d variables instead of %d: a value contains a line break or a quote that dotenv reads differently", len(got), len(keys))
	}
	for i := range keys {
		if got[i] != keys[i] {
			return "", fmt.Errorf("the environment text would read back with the variable %q instead of %q", got[i], keys[i])
		}
	}
	return text, nil
}
