/**
 * WarpMode Local Agent — WebSocket server for compiling/running code on the user's machine.
 *
 * Protocol (browser → agent):
 *   { type: "ping" }
 *   { type: "compile", id: string, language: string, files: [{ name, content }] }
 *   { type: "run",     id: string, language: string, files: [{ name, content }], entrypoint?: string }
 *
 * Protocol (agent → browser):
 *   { type: "pong", capabilities: string[] }
 *   { type: "stdout", id: string, data: string }
 *   { type: "stderr", id: string, data: string }
 *   { type: "exit",   id: string, code: number, signal?: string }
 *   { type: "error",  id: string, message: string }
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

// ── Version ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
let VERSION = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  VERSION = pkg.version;
} catch { /* ignore */ }

// ── Config ──────────────────────────────────────────────────────────────────

const MAX_EXEC_TIME_MS = 30_000; // 30s timeout per execution
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://warpmode.app',
  'https://www.warpmode.app',
  'https://aihuddle.com',
  'https://www.aihuddle.com',
];

// ── Language compile/run commands ────────────────────────────────────────────

const LANGUAGE_COMMANDS = {
  python: {
    compile: { cmd: 'python3', args: ['-m', 'py_compile', '{entrypoint}'] },
    run: { cmd: 'python3', args: ['{entrypoint}'] },
    defaultEntry: 'main.py',
    extensions: ['.py'],
  },
  javascript: {
    compile: { cmd: 'node', args: ['--check', '{entrypoint}'] },
    run: { cmd: 'node', args: ['{entrypoint}'] },
    defaultEntry: 'index.js',
    extensions: ['.js', '.mjs'],
  },
  typescript: {
    compile: { cmd: 'npx', args: ['tsc', '--noEmit', '--strict'] },
    run: { cmd: 'npx', args: ['tsx', '{entrypoint}'] },
    defaultEntry: 'index.ts',
    extensions: ['.ts', '.tsx'],
  },
  java: {
    compile: { cmd: 'javac', args: ['{entrypoint}'] },
    run: { cmd: 'java', args: ['{classname}'] },
    defaultEntry: 'Main.java',
    extensions: ['.java'],
  },
  rust: {
    compile: { cmd: 'cargo', args: ['check'] },
    run: { cmd: 'cargo', args: ['run'] },
    defaultEntry: 'src/main.rs',
    extensions: ['.rs'],
    needsCargo: true,
  },
  go: {
    compile: { cmd: 'go', args: ['build', './...'] },
    run: { cmd: 'go', args: ['run', '{entrypoint}'] },
    defaultEntry: 'main.go',
    extensions: ['.go'],
  },
  c: {
    compile: { cmd: 'gcc', args: ['-o', 'output', '{entrypoint}', '-lm'] },
    run: { cmd: './output', args: [] },
    defaultEntry: 'main.c',
    extensions: ['.c', '.h'],
  },
  cpp: {
    compile: { cmd: 'g++', args: ['-o', 'output', '{entrypoint}', '-std=c++17'] },
    run: { cmd: './output', args: [] },
    defaultEntry: 'main.cpp',
    extensions: ['.cpp', '.hpp', '.cc', '.h'],
  },
  csharp: {
    compile: { cmd: 'dotnet', args: ['build'] },
    run: { cmd: 'dotnet', args: ['run'] },
    defaultEntry: 'Program.cs',
    extensions: ['.cs'],
  },
  ruby: {
    compile: { cmd: 'ruby', args: ['-c', '{entrypoint}'] },
    run: { cmd: 'ruby', args: ['{entrypoint}'] },
    defaultEntry: 'main.rb',
    extensions: ['.rb'],
  },
  php: {
    compile: { cmd: 'php', args: ['-l', '{entrypoint}'] },
    run: { cmd: 'php', args: ['{entrypoint}'] },
    defaultEntry: 'index.php',
    extensions: ['.php'],
  },
  swift: {
    compile: { cmd: 'swiftc', args: ['-typecheck', '{entrypoint}'] },
    run: { cmd: 'swift', args: ['{entrypoint}'] },
    defaultEntry: 'main.swift',
    extensions: ['.swift'],
  },
  kotlin: {
    compile: { cmd: 'kotlinc', args: ['{entrypoint}', '-include-runtime', '-d', 'output.jar'] },
    run: { cmd: 'java', args: ['-jar', 'output.jar'] },
    defaultEntry: 'main.kt',
    extensions: ['.kt'],
  },
};

// ── Detect installed tools ──────────────────────────────────────────────────

async function detectCapabilities() {
  const capabilities = [];
  const checks = {
    python: ['python3', '--version'],
    node: ['node', '--version'],
    typescript: ['npx', 'tsc', '--version'],
    java: ['javac', '-version'],
    rust: ['cargo', '--version'],
    go: ['go', 'version'],
    gcc: ['gcc', '--version'],
    'g++': ['g++', '--version'],
    dotnet: ['dotnet', '--version'],
    ruby: ['ruby', '--version'],
    php: ['php', '--version'],
    swift: ['swiftc', '--version'],
    kotlin: ['kotlinc', '-version'],
  };

  const results = await Promise.allSettled(
    Object.entries(checks).map(async ([name, [cmd, ...cmdArgs]]) => {
      const result = await execQuick(cmd, cmdArgs, { timeout: 5000 });
      return result.exitCode === 0 ? name : null;
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      capabilities.push(result.value);
    }
  }

  return capabilities;
}

function execQuick(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, {
        timeout: opts.timeout || 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
      proc.on('error', () => resolve({ exitCode: 1, stdout, stderr }));
    } catch {
      resolve({ exitCode: 1, stdout: '', stderr: '' });
    }
  });
}

// ── Temp directory management ───────────────────────────────────────────────

function createTempProject(files) {
  const id = randomBytes(8).toString('hex');
  const tempDir = join(tmpdir(), `aihuddle-agent-${id}`);
  mkdirSync(tempDir, { recursive: true });

  for (const file of files) {
    const filePath = join(tempDir, file.name);
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, file.content, 'utf-8');
  }

  return tempDir;
}

function cleanupTempProject(dir) {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

// ── Scaffold Rust Cargo.toml if needed ──────────────────────────────────────

function scaffoldRustProject(tempDir, files) {
  const hasCargoToml = files.some(f => f.name === 'Cargo.toml');
  if (!hasCargoToml) {
    writeFileSync(
      join(tempDir, 'Cargo.toml'),
      `[package]\nname = "aihuddle-project"\nversion = "0.1.0"\nedition = "2021"\n`,
      'utf-8'
    );
  }
  const hasSrcMain = files.some(f => f.name.startsWith('src/'));
  if (!hasSrcMain) {
    const mainRs = files.find(f => f.name === 'main.rs');
    if (mainRs) {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src', 'main.rs'), mainRs.content, 'utf-8');
    }
  }
}

// ── Execute and stream output ───────────────────────────────────────────────

function executeAndStream(ws, jobId, cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    } catch (err) {
      sendJSON(ws, { type: 'error', id: jobId, message: `Failed to spawn ${cmd}: ${err.message}` });
      resolve(1);
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    const FLUSH_INTERVAL = 100;

    const flushInterval = setInterval(() => {
      if (stdoutBuf) {
        sendJSON(ws, { type: 'stdout', id: jobId, data: stdoutBuf });
        stdoutBuf = '';
      }
      if (stderrBuf) {
        sendJSON(ws, { type: 'stderr', id: jobId, data: stderrBuf });
        stderrBuf = '';
      }
    }, FLUSH_INTERVAL);

    proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    proc.on('close', (code, signal) => {
      clearInterval(flushInterval);
      if (stdoutBuf) sendJSON(ws, { type: 'stdout', id: jobId, data: stdoutBuf });
      if (stderrBuf) sendJSON(ws, { type: 'stderr', id: jobId, data: stderrBuf });
      sendJSON(ws, { type: 'exit', id: jobId, code: code ?? 1, signal: signal || undefined });
      resolve(code ?? 1);
    });

    proc.on('error', (err) => {
      clearInterval(flushInterval);
      if (stdoutBuf) sendJSON(ws, { type: 'stdout', id: jobId, data: stdoutBuf });
      if (stderrBuf) sendJSON(ws, { type: 'stderr', id: jobId, data: stderrBuf });
      sendJSON(ws, { type: 'error', id: jobId, message: err.message });
      resolve(1);
    });
  });
}

function sendJSON(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// ── Arg substitution ────────────────────────────────────────────────────────

function substituteArgs(args, entrypoint) {
  return args.map(arg => {
    let result = arg.replace('{entrypoint}', entrypoint);
    if (arg.includes('{classname}')) {
      const className = entrypoint.replace(/\.java$/, '').replace(/\//g, '.');
      result = result.replace('{classname}', className);
    }
    return result;
  });
}

// ── Handle compile ──────────────────────────────────────────────────────────

async function handleCompile(ws, msg) {
  const { id: jobId, language, files } = msg;
  const langKey = language.toLowerCase().replace(/\+\+/g, 'pp').replace(/#/g, 'sharp');
  const langConfig = LANGUAGE_COMMANDS[langKey];

  if (!langConfig) {
    sendJSON(ws, { type: 'error', id: jobId, message: `Unsupported language: ${language}` });
    return;
  }

  if (!langConfig.compile) {
    sendJSON(ws, { type: 'exit', id: jobId, code: 0 });
    return;
  }

  const tempDir = createTempProject(files);

  try {
    if (langConfig.needsCargo) scaffoldRustProject(tempDir, files);

    if (langKey === 'typescript' && !files.some(f => f.name === 'tsconfig.json')) {
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true, target: 'ES2020', module: 'ESNext',
            moduleResolution: 'node', esModuleInterop: true,
            skipLibCheck: true, noEmit: true,
          },
          include: ['**/*.ts', '**/*.tsx'],
        }, null, 2),
        'utf-8'
      );
    }

    const entrypoint = msg.entrypoint || langConfig.defaultEntry;
    const compileArgs = substituteArgs(langConfig.compile.args, entrypoint);
    await executeAndStream(ws, jobId, langConfig.compile.cmd, compileArgs, tempDir, MAX_EXEC_TIME_MS);
  } finally {
    cleanupTempProject(tempDir);
  }
}

// ── Handle run ──────────────────────────────────────────────────────────────

async function handleRun(ws, msg) {
  const { id: jobId, language, files } = msg;
  const langKey = language.toLowerCase().replace(/\+\+/g, 'pp').replace(/#/g, 'sharp');
  const langConfig = LANGUAGE_COMMANDS[langKey];

  if (!langConfig) {
    sendJSON(ws, { type: 'error', id: jobId, message: `Unsupported language: ${language}` });
    return;
  }

  const tempDir = createTempProject(files);

  try {
    if (langConfig.needsCargo) scaffoldRustProject(tempDir, files);

    const entrypoint = msg.entrypoint || langConfig.defaultEntry;

    if (langConfig.compile) {
      const compileArgs = substituteArgs(langConfig.compile.args, entrypoint);
      const exitCode = await executeAndStream(
        ws, jobId, langConfig.compile.cmd, compileArgs, tempDir, MAX_EXEC_TIME_MS
      );
      if (exitCode !== 0) return;
    }

    if (langConfig.run) {
      const runArgs = substituteArgs(langConfig.run.args, entrypoint);
      await executeAndStream(ws, jobId, langConfig.run.cmd, runArgs, tempDir, MAX_EXEC_TIME_MS);
    }
  } finally {
    cleanupTempProject(tempDir);
  }
}

// ── Exported entry point ────────────────────────────────────────────────────

export async function startServer(port = 9876) {
  console.log(`\x1b[36m  ╔══════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[36m  ║   WarpMode Local Agent v${VERSION.padEnd(12)}║\x1b[0m`);
  console.log(`\x1b[36m  ╚══════════════════════════════════════╝\x1b[0m`);
  console.log();
  console.log('  Detecting installed tools...');

  const capabilities = await detectCapabilities();

  if (capabilities.length > 0) {
    console.log(`  \x1b[32mAvailable:\x1b[0m ${capabilities.join(', ')}`);
  } else {
    console.log('  \x1b[33mNo compilers/interpreters detected\x1b[0m');
  }
  console.log();

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agent: 'aihuddle-local-agent', version: VERSION, capabilities }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info) => {
      const origin = info.origin || info.req.headers.origin;
      if (!origin) return true;
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return true;
      return ALLOWED_ORIGINS.includes(origin);
    },
  });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || 'unknown';
    console.log(`  \x1b[32m+\x1b[0m Client connected from ${origin}`);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendJSON(ws, { type: 'error', id: 'unknown', message: 'Invalid JSON' });
        return;
      }

      try {
        switch (msg.type) {
          case 'ping':
            sendJSON(ws, { type: 'pong', capabilities });
            break;

          case 'compile':
            if (!msg.id || !msg.language || !Array.isArray(msg.files)) {
              sendJSON(ws, { type: 'error', id: msg.id || 'unknown', message: 'Missing required fields: id, language, files' });
              break;
            }
            console.log(`  \x1b[34m>\x1b[0m Compile ${msg.language} (${msg.files.length} files)`);
            await handleCompile(ws, msg);
            break;

          case 'run':
            if (!msg.id || !msg.language || !Array.isArray(msg.files)) {
              sendJSON(ws, { type: 'error', id: msg.id || 'unknown', message: 'Missing required fields: id, language, files' });
              break;
            }
            console.log(`  \x1b[34m>\x1b[0m Run ${msg.language} (${msg.files.length} files)`);
            await handleRun(ws, msg);
            break;

          default:
            sendJSON(ws, { type: 'error', id: msg.id || 'unknown', message: `Unknown message type: ${msg.type}` });
        }
      } catch (err) {
        sendJSON(ws, { type: 'error', id: msg.id || 'unknown', message: `Internal error: ${err.message}` });
      }
    });

    ws.on('close', () => {
      console.log('  \x1b[31m-\x1b[0m Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('  \x1b[31m!\x1b[0m WebSocket error:', err.message);
    });
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`  \x1b[32mListening on\x1b[0m ws://127.0.0.1:${port}`);
    console.log(`  \x1b[90mHealth check:\x1b[0m http://127.0.0.1:${port}/health`);
    console.log();
    console.log('  Waiting for browser connection...');
    console.log('  \x1b[90mOpen AIHuddle codespace and click "Local Agent" to connect\x1b[0m');
    console.log();
  });
}
