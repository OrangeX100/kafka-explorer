package application

import "testing"

// Locks the update-check version comparison to semver precedence rules —
// the update dialog's "已是最新"/"发现新版" verdicts depend on exactly
// this ordering (release > pre-release; beta.N iterates within a triple).
func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		less bool
	}{
		// releases
		{"0.2.0", "0.3.0", true},
		{"0.2.0", "0.2.1", true},
		{"0.3.0", "0.2.0", false},
		{"0.2.0", "0.2.0", false},
		{"v0.2.0", "0.2.0", false},          // v-prefix + build junk ignored
		{"0.2.0+build.5", "0.2.0", false},   // build metadata never compares
		{"10.0.0", "9.9.9", false},          // numeric, not lexical
		// pre-releases sort before their own release
		{"0.2.0-beta.1", "0.2.0", true},
		{"0.2.0-beta.9", "0.2.0", true},
		{"0.2.0-rc.1", "0.2.0", true},
		// betas iterate within a triple
		{"0.2.0-beta.1", "0.2.0-beta.2", true},
		{"0.2.0-beta.2", "0.2.0-beta.10", true},   // numeric: 2 < 10
		{"0.2.0-beta.2", "0.2.0-beta.1", false},
		{"0.2.0-beta.1", "0.2.0-beta.1", false},
		// numeric < alphanumeric identifiers
		{"0.2.0-1", "0.2.0-beta", true},
		{"0.2.0-beta", "0.2.0-1", false},
		// rc outranks beta of the same triple
		{"0.2.0-beta.1", "0.2.0-rc.1", true},
		// longer pre-release list outranks its own prefix
		{"0.2.0-beta.1", "0.2.0-beta.1.1", true},
		// triple wins over any pre-release difference
		{"0.2.0-beta.2", "0.3.0-alpha.1", true},
	}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.less {
			t.Errorf("versionLess(%q, %q) = %v, want %v", c.a, c.b, got, c.less)
		}
	}
}
