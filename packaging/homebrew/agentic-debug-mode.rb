class AgenticDebugMode < Formula
  desc "Evidence-first debugging CLI for coding agents"
  homepage "https://github.com/Toubat/debug-mode"
  version "REPLACE_VERSION"
  license "MIT"

  on_arm do
    url "https://github.com/Toubat/debug-mode/releases/download/v#{version}/agentic-debug-mode-darwin-arm64.tar.gz"
    sha256 "REPLACE_DARWIN_ARM64_SHA256"
  end

  on_intel do
    url "https://github.com/Toubat/debug-mode/releases/download/v#{version}/agentic-debug-mode-darwin-x64.tar.gz"
    sha256 "REPLACE_DARWIN_X64_SHA256"
  end

  def install
    bin.install "debug-mode"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/debug-mode --version")
  end
end
