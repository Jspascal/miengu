class Miengu < Formula
  desc "Evidence-bound deterministic software-delivery supervisor"
  homepage "https://github.com/__MIENGU_REPOSITORY__"
  version "__MIENGU_VERSION__"
  url "https://github.com/__MIENGU_REPOSITORY__/releases/download/v__MIENGU_VERSION__/miengu-v__MIENGU_VERSION__.tar.gz"
  sha256 "__RELEASE_SHA256__"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"miengu").write_env_script libexec/"bin/miengu", PATH: "#{Formula["node"].opt_bin}:$PATH"
  end

  test do
    assert_match "Usage", shell_output("#{bin}/miengu --help")
  end
end
