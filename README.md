# Miengu

Miengu is an evidence-bound, deterministic software-delivery supervisor.

## Local development

Requires Node.js 20 or newer.

```sh
npm ci
npm run build
node dist/cli/index.js --help
```

## Installing a release

After a GitHub release is published, install with Homebrew:

```sh
brew tap Jspascal/tap
brew install miengu
```

Or use the checksum-verifying installer:

```sh
wget -qO- https://github.com/Jspascal/miengu/releases/latest/download/miengu-install.sh | sh
```

The release is a portable Node.js package. Homebrew installs Node automatically; direct installs
require Node.js 20+ and install the command in `~/.local/bin` by default.
