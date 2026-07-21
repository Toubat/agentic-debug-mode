class AgenticDebugMode < Formula
  desc "Evidence-first debugging CLI for coding agents"
  homepage "https://github.com/Toubat/agentic-debug-mode"
  version "0.3.0"
  license "MIT"

  on_arm do
    url "https://github.com/Toubat/agentic-debug-mode/releases/download/v#{version}/agentic-debug-mode-darwin-arm64.tar.gz"
    sha256 "0c6f65a222c8ce0c3a6a9e1f64b79adcdfd8646d441ae1c5b533e5bf81761566"
  end

  on_intel do
    url "https://github.com/Toubat/agentic-debug-mode/releases/download/v#{version}/agentic-debug-mode-darwin-x64.tar.gz"
    sha256 "f373fed33e19909b7d31ec635e8a7c6c7f8d4e12d21db6faefb797c0636edfa3"
  end

  def install
    bin.install "debug-mode"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/debug-mode --version")
  end
end
