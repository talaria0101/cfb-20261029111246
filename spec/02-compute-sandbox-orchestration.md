# Compute & Sandbox Orchestration: Docker, Nomad, MicroVMs, Amika, and Mirrord

## 1. Remote Container Management from Edge Isolates

Cloudflare Workers run in stateless V8 isolates without Linux kernel namespaces, cgroups, or raw sockets. To provision, start, stop, and monitor long-running containers from a Cloudflare Worker control plane, requests must be proxied over **Cloudflare Tunnels** to an orchestration agent or container engine API on the host.

---

## 2. Docker & Podman Engine API over Cloudflare Tunnel

### 2.1 The Docker Engine API
The Docker daemon exposes a comprehensive REST API over Unix domain socket (`/var/run/docker.sock`) or TCP (`http://127.0.0.1:2375`).
- Container lifecycle: `POST /v1.44/containers/create`, `POST /v1.44/containers/{id}/start`, `POST /v1.44/containers/{id}/stop`, `DELETE /v1.44/containers/{id}`.
- Real-time logs: `GET /v1.44/containers/{id}/logs?follow=1&stdout=1&stderr=1`.
- Interactive terminal: `POST /v1.44/containers/{id}/attach/ws` (WebSocket).
- Remote file management: `GET /v1.44/containers/{id}/archive` and `PUT /v1.44/containers/{id}/archive` (tar streaming).

### 2.2 Security Hardening: `tecnativa/docker-socket-proxy`
Exposing the raw Docker socket to any network interface—even over an authenticated private tunnel—presents extreme risk. A compromised API token could allow mounting the host root filesystem (`-v /:/host`) or executing privileged containers.

To mitigate this, deploy [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy), an HAProxy-based filtering proxy that blocks destructive API paths and restricts access to safe container operations:

```yaml
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    container_name: docker-proxy
    restart: unless-stopped
    ports:
      - "127.0.0.1:2375:2375"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      # Enable safe container management
      CONTAINERS: 1
      IMAGES: 1
      INFO: 1
      PING: 1
      VERSION: 1
      POST: 1
      DELETE: 1
      # Disable dangerous host manipulation
      VOLUMES: 0
      NETWORKS: 0
      SYSTEM: 0
      SWARM: 0
      NODES: 0
      SERVICES: 0
      SECRETS: 0
      CONFIGS: 0
      PLUGINS: 0
      AUTH: 0
```

### 2.3 Interactive Terminal over WebSocket
The Cloudflare Worker initiates a WebSocket upgrade against Docker's attach endpoint:
```typescript
// Edge Worker routes /api/sandboxes/terminal/:containerId
const wsUrl = new URL(env.DOCKER_TUNNEL_HOST);
wsUrl.protocol = "wss:";
wsUrl.pathname = `/v1.44/containers/${containerId}/attach/ws`;
wsUrl.search = "?stream=1&stdin=1&stdout=1&stderr=1";

const originWsRes = await fetch(wsUrl.toString(), {
  headers: {
    Upgrade: "websocket",
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
  },
});

const serverSocket = originWsRes.webSocket;
if (!serverSocket) {
  return new Response("Failed to connect to container terminal", { status: 502 });
}

// Pair WebSockets to stream terminal I/O to the browser
const [client, worker] = Object.values(new WebSocketPair());
worker.accept();
serverSocket.accept();

worker.addEventListener("message", (e) => serverSocket.send(e.data));
serverSocket.addEventListener("message", (e) => worker.send(e.data));
serverSocket.addEventListener("close", () => worker.close());
worker.addEventListener("close", () => serverSocket.close());

return new Response(null, { status: 101, webSocket: client });
```

### 2.4 Web SFTP File Explorer (OmnySSH Pattern)
Rather than relying solely on bash terminal commands to inspect container files, the Cloudflare Pages SPA incorporates the dual-pane file management design of [timhartmann7/omnyssh](https://github.com/timhartmann7/omnyssh):
- The Worker queries `/containers/{id}/archive?path=/workspace` to extract directories and download files.
- Operators can upload configuration files, assets, and dependencies directly into target sandboxes without restarting the container.

---

## 3. Remote Context & Traffic Mirroring: `metalbear-co/mirrord`

A major challenge when using remote self-hosted compute is local developer and AI agent ergonomics. Running tests or coding agents locally often requires access to the remote database, S3 storage, and internal microservices.

[metalbear-co/mirrord](https://github.com/metalbear-co/mirrord) bridges this gap:

```
┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
│  LOCAL MACHINE / AI AGENT (Cursor)   │          │     REMOTE DATA PLANE (Hetzner)      │
│                                      │          │                                      │
│  [Local Process / Coding Agent]      │          │  [Target Sandbox Container]          │
│    - mirrord layer (LD_PRELOAD)      │          │    - Real database connections       │
│    - Hooks connect(), bind(), open() │          │    - Real Garage S3 / workerd mesh   │
│              │                       │          │              │                       │
└──────────────┼───────────────────────┘          └──────────────┼───────────────────────┘
               │                                                 │
               │ Encrypted Cloudflare Tunnel / mirrord session   │
               └─────────────────────────────────────────────────┘
```

### Capabilities of mirrord in this Architecture:
1. **Traffic Mirroring & Stealing**: Passively copies incoming HTTP/TCP requests from the remote container to the local agent, allowing real-time debugging without disrupting production or staging pipelines.
2. **Remote DNS Resolution**: When the local process resolves `garage.internal` or `workerd.internal`, mirrord intercepts `getaddrinfo` and resolves the name using the remote host's private network stack.
3. **Environment Injection**: Pulls environment variables and secrets dynamically from the remote sandbox into the local execution context.
4. **File Operations**: Remote file reads (`open`, `read`) are piped over the tunnel, giving the local process seamless access to remote configuration files.

---

## 4. Userspace Sandboxing & Tunnel Fallback: `talaria0101/cfrs`

In highly restricted sandboxes (e.g. nested unprivileged containers, minimal Alpine images, environments where UDP/QUIC or port 7844 is filtered), the standard 40MB Go `cloudflared` binary fails.

[talaria0101/cfrs](https://github.com/talaria0101/cfrs) provides a lightweight Rust alternative:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   RESTRICTED UNPRIVILEGED SANDBOX                      │
│                                                                        │
│  [Process / Service]                                                  │
│    - Binds 10.66.0.2:8080 (No kernel AF_INET access)                   │
│    - Interposed by libcfrsnet.so (LD_PRELOAD)                          │
│         │                                                              │
│         ▼ (Rewritten to abstract socket: \0cfrsnet/v4/10.66.0.2/8080)   │
│  [cfrs net Userspace IP Stack (smoltcp)]                               │
│    - Private 10.66.0.0/24 network in userspace                         │
│    - Requires ZERO root, CAP_NET_ADMIN, or kernel network namespaces   │
│         │                                                              │
│         ▼                                                              │
│  [cfrs quick-tunnel / serve]                                           │
│    - Anonymous Cloudflare quick-tunnel via HTTP CONNECT proxy          │
│    - Fallback: SSH remote forward on port 443 to external relay        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Outbound HTTPS / SSH (Port 443)
                                    ▼
                      [ Public Web Preview URL ]
```

### Key Integrations of `cfrs`:
1. **Userspace IP Stack without Root (`cfrs net`)**: Enables running complex networked services in unprivileged containers without requiring `--privileged` or `CAP_NET_ADMIN` Docker flags.
2. **Anonymous Quick Tunnels**: Generates instant temporary public preview URLs (`POST /tunnel` via HTTP proxy) for ad-hoc container previews.
3. **SSH Remote Forwarding Fallback (`cfrs serve`)**: When Cloudflare edge port 7844 is blocked by intermediate firewalls, carries tunnels over an SSH remote forward on port 443, splicing visitor connections to local Unix sockets.

---

## 5. In-Depth Analysis of `gofixpoint/amika`

[gofixpoint/amika](https://github.com/gofixpoint/amika) provides a reference blueprint for orchestrating remote VMs and coding environments from Cloudflare edge services.

### 5.1 Core Subsystems
1. **`go/cmd/amikad/` (In-Guest Daemon)**:
   - Runs inside the VM sandbox at `/usr/local/bin/amikad`.
   - Binds OpenSSH `sshd` strictly to `127.0.0.1:22` (loopback only).
   - Starts an authenticated loopback HTTP server on port `60999` exposing `GET /v1/ssh-sessions`.
   - When an SSH client connects, it upgrades the connection to WebSocket, verifies a one-time 32-byte secret token, and pipes bytes bidirectionally between the WebSocket and `127.0.0.1:22`. This grants terminal access without exposing raw SSH ports.
2. **`js/amika-hostd/` (Host Compute Daemon)**:
   - Runs on the physical host, wrapping `smolvm serve` to manage local microVMs via KVM or Apple Hypervisor.
   - Dials outbound to the control plane, eliminating incoming firewall configuration.
3. **`js/tunnel-protocol/` (`amika.tunnel.v2`)**:
   - Pure Web-standard multiplexing binary codec using `Uint8Array`, `DataView`, and `TextEncoder`.
   - Zero Node.js dependencies: runs natively inside Cloudflare Workers and Durable Objects.
   - Binary frame structure (5-byte header):
     - Byte 0: `Frame Type` (1=OPEN, 2=RESPONSE, 3=DATA, 4=END, 5=RESET, 6=WINDOW, 7=TEXT, 8=BINARY, 9=CLOSE).
     - Bytes 1–4: `Stream ID` (big-endian 32-bit unsigned int).
   - **Credit-Based Flow Control**: Senders are restricted to 256 KiB credit windows until receivers emit `WINDOW` frames, preventing fast compute nodes from overwhelming Cloudflare Worker memory buffers.
   - **Zero-Cost WebSocket Auto-Response**:
     - Host emits ping frame `amika.tunnel.v2.ping` every 30s.
     - Cloudflare Durable Object configures `setWebSocketAutoResponse`, allowing Cloudflare Edge to return `amika.tunnel.v2.pong` **without waking the Durable Object from sleep**, incurring zero execution cost.

---

## 6. MicroVM & Sandbox Runtimes

For untrusted multi-tenant workloads, raw Docker containers share the host Linux kernel. To achieve true virtualization:

1. **gVisor (`runsc`)**:
   - Intercepts and executes Linux syscalls in user space.
   - Plugs directly into Docker (`--runtime=runsc`) and Nomad.
   - Adds ~10–15% CPU overhead on heavy I/O, but provides robust defense against kernel exploits.
2. **Firecracker ([firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker))**:
   - Minimalist KVM-based Virtual Machine Monitor written in Rust.
   - Boots Linux kernels in ~5ms with ~5MB RAM overhead.
   - Can be scheduled directly via Nomad using `nomad-driver-firecracker`.
3. **Incus / LXC ([zabbly/incus](https://github.com/zabbly/incus))**:
   - High-density system containers and lightweight VMs with REST API access.
   - Excellent for stateful multi-user persistent dev boxes.
