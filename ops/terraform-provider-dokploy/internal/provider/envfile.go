package provider

import (
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
		key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		if !envKeyPattern.MatchString(key) {
			continue
		}
		value := line[eq+1:]
		raw := line
		if q := openQuote(value); q != 0 {
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
	if v != "" && (v[0] == '"' || v[0] == '\'') {
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
		lines[k] = k + "=" + v
	}
	var missing []string
	for _, k := range secretKeys {
		if _, dup := lines[k]; dup {
			return "", fmt.Errorf("variable %q is declared both in env and in secret_env_keys", k)
		}
		if v, ok := secretValues[k]; ok {
			lines[k] = k + "=" + v
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
	return b.String(), nil
}
