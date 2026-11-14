package wails

import (
	"os"
	"testing"

	"kafkaexplorer/internal/application"
)

// TestMain admits httptest fixture URLs for the whole test binary: the
// staging tests download from local servers, which the production
// GitHub-only asset guard (044 review round) rightly rejects.
func TestMain(m *testing.M) {
	restore := application.SetAssetURLGuardForTests(nil)
	code := m.Run()
	restore()
	os.Exit(code)
}
