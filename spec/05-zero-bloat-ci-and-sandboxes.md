# Heavy Compute & CI: Embedded Zero-Bloat Runner in `cfb-broker`

## 1. Why Dedicated CI Daemons are Bloat

Traditional CI solutions require heavy infrastructure:
- **Woodpecker CI**: Requires a separate `woodpecker-server` daemon, a SQLite/Postgres database, and one or more `woodpecker-agent` containers communicating over gRPC. Total footprint: **~120–200 MB RAM idle**.
- **GitLab Runner / GitHub Actions Runner**: Heavy Go/.NET agents constantly polling APIs.

When building a self-hosted alternative to Cloudflare Workers CI, running a multi-container CI platform just to run builds on a single server is unnecessary.

### The `cfb-broker` Embedded Runner
`cfb-broker` embeds the task runner directly into its single async Rust binary:
- **Zero Idle Overhead**: When no builds are running, the runner consumes **0 MB additional RAM**.
- **Direct Docker/Podman Integration**: Communicates directly with the local Docker or Podman Unix socket via HTTP/Unix-domain-socket streams.
- **Native SSE Log Streaming**: Streams container stdout/stderr line-by-line directly over Server-Sent Events (SSE) through the Cloudflare Tunnel to the Cloudflare Pages SPA dashboard.

---

## 2. End-to-End Build Pipeline Data Flow

```
                      1. Git Push Webhook (GitHub / GitLab)
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │ Cloudflare Edge Worker                           │
             │ • Verifies HMAC-SHA256 signature via WebCrypto   │
             │ • Extracts repo, branch, commit, and workflow    │
             │ • Injects Cloudflare Access Service Token        │
             └────────────────────────┬─────────────────────────┘
                                      │
                                      │ POST /ci/dispatch over Tunnel
                                      ▼
 ════════════════════════════════════════════════════════════════════════
                             cfb-broker (Host Node)
 ════════════════════════════════════════════════════════════════════════
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │ In-Process Task Queue (Async Tokio Channels)     │
             │ • Allocates Job ID (e.g. job-8491)               │
             │ • Assigns workspace directory                    │
             └────────────────────────┬─────────────────────────┘
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │ Ephemeral OCI Container Runner                   │
             │ • Connects to /var/run/docker.sock               │
             │ • Mounts host cache: /var/cache/cfb/cargo        │
             │ • Runs pipeline steps in isolated containers:    │
             │     Step 1: git clone                            │
             │     Step 2: cargo test / npm run build           │
             │     Step 3: docker build (DinD)                  │
             └────────────────────────┬─────────────────────────┘
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │ Real-Time SSE Log Broadcast                      │
             │ GET /ci/stream/:jobId                            │
             │ • Pipes stdout/stderr frames line-by-line        │
             │ • Transits Cloudflare Tunnel without buffering   │
             └────────────────────────┬─────────────────────────┘
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │ Cloudflare Pages SPA Dashboard (Live Terminal)   │
             └──────────────────────────────────────────────────┘
```

---

## 3. Pipeline Definition: Standard Container Steps

The build payload submitted from the Cloudflare Worker defines standard container steps:

```json
{
  "jobId": "build-9481",
  "repoUrl": "https://github.com/my-org/my-project.git",
  "commit": "a1b2c3d4",
  "steps": [
    {
      "name": "compile-and-test",
      "image": "rust:1.82-alpine",
      "commands": [
        "cargo check --release",
        "cargo test --all"
      ],
      "caches": [
        { "hostPath": "/var/cache/cfb/cargo", "containerPath": "/usr/local/cargo/registry" },
        { "hostPath": "/var/cache/cfb/target", "containerPath": "/target" }
      ]
    },
    {
      "name": "docker-build",
      "image": "docker:dind",
      "commands": [
        "docker build -t my-app:latest .",
        "docker run --rm my-app:latest /app/healthcheck"
      ]
    }
  ]
}
```

---

## 4. Real-Time Zero-Buffering SSE Stream

The Cloudflare Pages SPA dashboard connects to `GET /ci/stream/:jobId` via `EventSource`:
- `cfb-broker` demultiplexes Docker binary log frames (8-byte header: stdout vs stderr).
- It formats each line as `data: {"step": "compile", "stream": "stdout", "text": "Compiling crate v1.0.0"}\n\n`.
- The Cloudflare Worker edge proxy pipes the stream with `Cache-Control: no-transform` and `X-Accel-Buffering: no`.
- The terminal in the browser dashboard renders live compilation output in real time.

---

## 5. Security & Isolation

1. **Ephemeral Execution**: Each pipeline step runs in an ephemeral container removed immediately on completion (`--rm`).
2. **Untrusted Code Containment**: Pipeline steps executing third-party code run with the **gVisor (`runsc`)** runtime, preventing container escapes from touching the host kernel.
3. **Cache Directory Scoping**: Cache directories are scoped per repository (`/var/cache/cfb/repos/<repo-id>`), preventing cross-tenant cache poisoning.
