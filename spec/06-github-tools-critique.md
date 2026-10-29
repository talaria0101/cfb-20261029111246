# Technical Evaluation: Referenced Tools & Prior Art

## 1. Technical Evaluation Matrix

| Tool | Repository | Language | Memory | License | Integration in Architecture |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **cfrs** | `talaria0101/cfrs` | Rust | ~8 MiB | 0BSD | Ingress tunnel core and userspace networking foundation |
| **workerd** | `cloudflare/workerd` | C++ | ~30 MiB | Apache-2.0 | Supervised V8 execution engine for Workers and Durable Objects |
| **amika** | `gofixpoint/amika` | Go / TS | ~100 MiB | Apache-2.0 | Multiplexing protocol (`@amika/tunnel-protocol`) and loopback SSH |
| **mirrord** | `metalbear-co/mirrord` | Rust | ~20 MiB | MIT | Dynamic linker interposition for local and agent traffic mirroring |
| **ServerBee** | `ZingerLittleBee/ServerBee`| Rust | ~15 MiB | AGPL-3.0 | Consolidated into in-process sysinfo telemetry module |
| **homelable** | `Pouzor/homelable` | TS | ~80 MiB | GPL-3.0 | Dynamic topology graph model for Cloudflare Pages SPA |
| **omnyssh** | `timhartmann7/omnyssh` | Rust | ~40 MiB | GPL-3.0 | Web SFTP file explorer and snippet manager patterns |
| **woodpecker**| `woodpecker-ci/woodpecker` | Go | ~120 MiB | Apache-2.0 | Replaced by embedded CI runner in `cfb-broker` |
| **garage** | `deuxfleurs-org/garage` | Rust | ~50 MiB | AGPL-3.0 | Replaced by embedded S3 storage engine in `cfb-broker` |
| **docker-proxy**| `tecnativa/docker-socket-proxy`| HAProxy | ~15 MiB | MIT | Replaced by internal filtering router in `cfb-broker` |

---

## 2. Technical Findings by Component

### 2.1 `talaria0101/cfrs`
- Mechanism: Implements Cloudflare Argo Tunnel protocol over QUIC and HTTP/2. Includes an `LD_PRELOAD` shim (`libcfrsnet.so`) mapping `AF_INET` syscalls to `AF_UNIX` abstract sockets alongside a `smoltcp` userspace network stack.
- Consequence: Provides the transport core for `cfb-broker`, allowing single-binary tunnel ingress and unprivileged sandbox networking.

### 2.2 `cloudflare/workerd`
- Mechanism: C++/V8 runtime implementing Cloudflare Workers APIs. Supports SQLite-backed Durable Objects on disk (`localDisk`) with `state.storage.sql.exec`, hibernated WebSockets, and `workerLoader` dynamic module injection.
- Consequence: Provides exact API parity for Workers and Durable Objects without reimplementing the V8 execution pipeline.

### 2.3 `metalbear-co/mirrord`
- Mechanism: Interposes libc networking (`connect`, `bind`, `getaddrinfo`) and file syscalls (`open`, `read`) on a local process, forwarding calls to a target container.
- Consequence: Allows local developer machines and AI coding agents to execute against remote databases, S3 storage, and internal DNS without deploying code.

### 2.4 `gofixpoint/amika`
- Mechanism: Authors `@amika/tunnel-protocol` (`amika.tunnel.v2`), a binary multiplexing codec built on Web standards (`Uint8Array`, `DataView`, `TextEncoder`). Features 256 KiB credit-based windowing and string keep-alive frames compatible with Cloudflare's `setWebSocketAutoResponse`.
- Consequence: Provides the edge-to-node multiplexing protocol executed inside Cloudflare Workers and Durable Objects.

### 2.5 `ZingerLittleBee/ServerBee`
- Mechanism: Rust agent polling system metrics via `sysinfo` and streaming JSON payloads over WebSockets.
- Consequence: Inlined into `cfb-broker` as an internal async task, eliminating external monitoring daemons.

### 2.6 `Pouzor/homelable` & `crocofied/CoreObs`
- Mechanism: Graph-based network topology visualizer and multi-host uptime tracker.
- Consequence: Adopted into the Cloudflare Pages SPA dashboard for rendering live node-to-service topological graphs.

### 2.7 `timhartmann7/omnyssh`
- Mechanism: Dual-pane SFTP directory browser and parameterized snippet execution manager.
- Consequence: Implemented in the Cloudflare Pages SPA and Worker API for inspecting container workspaces and executing operational snippets.
