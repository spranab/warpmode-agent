#!/usr/bin/env node

/**
 * WarpMode Local Agent CLI
 *
 * Usage:
 *   npx warpmode-agent                  # default port 9876
 *   npx warpmode-agent --port 9877      # custom port
 *   npx warpmode-agent --help           # show help
 */

import { startServer } from '../lib/server.mjs';

const args = process.argv.slice(2);

// ── Help ────────────────────────────────────────────────────────────────────

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  WarpMode Local Agent — compiles & runs AI-generated code on your machine.

  Usage:
    npx warpmode-agent [options]

  Options:
    --port <number>   WebSocket server port (default: 9876)
    --help, -h        Show this help message
    --version, -v     Show version

  How it works:
    1. Start this agent in your terminal
    2. Open AIHuddle/WarpMode codespace in your browser
    3. Click "Local Agent" in the toolbar to connect
    4. The pipeline will use real compilation from your machine

  Supported languages (auto-detected):
    Python, JavaScript, TypeScript, Java, Rust, Go, C, C++,
    C#, Ruby, PHP, Swift, Kotlin
`);
  process.exit(0);
}

// ── Version ─────────────────────────────────────────────────────────────────

if (args.includes('--version') || args.includes('-v')) {
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  console.log(`warpmode-agent v${pkg.version}`);
  process.exit(0);
}

// ── Parse port ──────────────────────────────────────────────────────────────

let port = 9876;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${args[i + 1]}`);
      process.exit(1);
    }
    i++;
  }
}

// ── Start server ────────────────────────────────────────────────────────────

startServer(port);
