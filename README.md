# warpmode-agent

Local compilation agent for [WarpMode](https://warpmode.app) codespace. Compiles and runs AI-generated code on your machine, feeding real compiler errors back into the fix loop.

## Quick Start

```bash
npx warpmode-agent
```

Then open WarpMode codespace in your browser and click **"Local Agent"** in the toolbar.

## How It Works

```
Browser (WarpMode)              Your Machine
     │                               │
     │   WebSocket connect            │
     ├──────────────────────────────►│  warpmode-agent
     │                               │
     │   Send code files              │
     ├──────────────────────────────►│  Write to temp dir
     │                               │  Run compiler
     │   Stream compiler output       │
     │◄──────────────────────────────┤  Return errors
     │                               │
     │   Parse errors → fix loop      │
```

1. The agent starts a WebSocket server on `localhost:9876`
2. Your browser connects when you click "Local Agent"
3. During the build pipeline, code files are sent to the agent
4. The agent writes them to a temp directory and runs the real compiler
5. Compiler output (stdout/stderr) is streamed back to the browser
6. Errors are parsed and fed into the iterative fix loop

## Supported Languages

Auto-detected based on what's installed on your machine:

| Language | Compile | Run | Requires |
|----------|---------|-----|----------|
| Python | `python3 -m py_compile` | `python3` | python3 |
| JavaScript | `node --check` | `node` | node |
| TypeScript | `tsc --noEmit` | `tsx` | node, typescript |
| Java | `javac` | `java` | JDK |
| Rust | `cargo check` | `cargo run` | rustc, cargo |
| Go | `go build` | `go run` | go |
| C | `gcc` | compiled binary | gcc |
| C++ | `g++` | compiled binary | g++ |
| C# | `dotnet build` | `dotnet run` | .NET SDK |
| Ruby | `ruby -c` | `ruby` | ruby |
| PHP | `php -l` | `php` | php |
| Swift | `swiftc -typecheck` | `swift` | swiftc |
| Kotlin | `kotlinc` | `java -jar` | kotlinc, JDK |

## Options

```bash
npx warpmode-agent --port 9877   # custom port
npx warpmode-agent --help        # show help
npx warpmode-agent --version     # show version
```

## Security

- Only listens on `127.0.0.1` (localhost only, not exposed to network)
- Origin verification: only accepts connections from localhost and warpmode.app
- Code runs in temp directories that are cleaned up after each job
- 30-second execution timeout per job
- No data is sent to any external server

## License

MIT
