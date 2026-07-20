class AgenticDebugMode < Formula
  desc "Evidence-first debugging CLI for coding agents"
  homepage "https://github.com/Toubat/agentic-debug-mode"
  version "0.2.3"
  license "MIT"

  on_arm do
    url "https://github.com/Toubat/agentic-debug-mode/releases/download/v#{version}/agentic-debug-mode-darwin-arm64.tar.gz"
    sha256 "2d3d8496398ff9edc90c0d5b1eca548e036fd98440ead3df5751707c27e17a0d"
  end

  on_intel do
    url "https://github.com/Toubat/agentic-debug-mode/releases/download/v#{version}/agentic-debug-mode-darwin-x64.tar.gz"
    sha256 "9dc23df397779280919f1ead447c90d7bfeb28b3cc5e232f9c45af530f5f00f7"
  end

  def install
    bin.install "debug-mode"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/debug-mode --version")
  end
end
