# Heavy CI & Runner Orchestration: Woodpecker CI over Cloudflare Tunnels

## 1. Problem Statement: Why Workers CI Fails for Heavy Workloads

Serverless CI systems like Cloudflare Workers CI enforce tight constraints:
- Inability to run Docker daemon or Docker-in-Docker (DinD).
- Inability to mount host volumes or cache multi-gigabyte build artifacts (e.g. `node_modules`, Cargo `target/`, ccache).
- Hard CPU time caps and strict memory limits.

For projects requiring heavy containerized CI (multi-arch Docker builds, C++/Rust compilation, machine learning model validation), an edge-controlled self-hosted CI platform is essential.

---

## 2. Engine Evaluation: Woodpecker CI vs. Act Runner vs. Drone CI

| Dimension | **Woodpecker CI** ([woodpecker-ci/woodpecker](https://github.com/woodpecker-ci/woodpecker)) | **Forgejo / Act Runner** ([nektos/act](https://github.com/nektos/act)) | **Drone CI** ([harness/drone](https://github.com/harness/drone)) |
| :--- | :--- | :--- | :--- |
| **License** | **Apache-2.0** (100% Free & Open Source) | **MIT** (`act`) / **GPL-3.0** (`forgejo-runner`) | **PolyForm Small Business** (Commercial restrictions) |
| **Pipeline Syntax** | Woodpecker YAML (`.woodpecker/*.yaml`, Docker container steps, DAGs) | Standard **GitHub Actions YAML** (`.github/workflows/*.yaml`) | Drone YAML (`.drone.yml`) |
| **Log Streaming** | Native **Server-Sent Events (SSE)** (`/api/stream/logs/...`) & REST | Connect-RPC chunked batch uploads | WebSockets / SSE |
| **Execution Backends** | Docker, Podman, Kubernetes, Local (host), SSH | Docker, Host (direct), LXC | Docker, Kubernetes, Exec |
| **Fit with CF Tunnel** | **Ideal**: Server speaks standard HTTP/REST/SSE; agents connect locally via gRPC. | Very Good: Emulates GitHub Actions. | Discouraged: Enterprise features gated by Harness. |

### Why Woodpecker CI is the Recommended Platform
1. **Decoupled Architecture**: The `woodpecker-server` handles webhooks, job queues, and log storage via standard HTTP and SSE. The `woodpecker-agent` runs on the local network, executing jobs inside ephemeral Docker containers without exposing the Docker daemon to the internet.
2. **First-Class SSE**: Live build logs can be streamed directly through Cloudflare Workers to a browser dashboard using native Server-Sent Events without any custom translation bridges.
3. **No Commercial Trap**: Fully governed by a community non-profit foundation with an Apache-2.0 license.

---

## 3. End-to-End System Architecture

```
                        PUBLIC INTERNET / EDGE
                               │
       1. Webhook (GitHub/GitLab)       2. Live Log Viewer / Dashboard (SPA)
               │                                      │
               ▼                                      ▼
    ┌──────────────────────────────────────────────────────────────┐
    │              Cloudflare Edge (Workers / Pages)               │
    │                                                              │
    │  [ POST /webhook/github ]         [ GET /api/stream/logs ]   │
    │  - HMAC-SHA256 Signature Verify   - Edge SSE Proxy           │
    │  - Branch / Path Routing          - Zero-buffering pipe      │
    │  - Injects CF Access Headers      - Streams to Browser UI    │
    └──────────────────────────────┬───────────────────────────────┘
                                   │
              3. Encrypted Cloudflare Tunnel (QUIC / HTTP/2)
                                   │
                                   ▼
 ══════════════════════════════════════════════════════════════════════
               PRIVATE INFRASTRUCTURE / HOME LAB / VPC
 ══════════════════════════════════════════════════════════════════════
                                   │
                    ┌──────────────┴──────────────┐
                    │      cloudflared daemon     │
                    └──────────────┬──────────────┘
                                   │
                  Reverse Proxy over Local Bridge Network
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │    Woodpecker CI Server     │
                    │  (REST API, Webhook, SSE)   │
                    └──────────────┬──────────────┘
                                   │
                        gRPC Internal Network
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        ▼                                                     ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│     Woodpecker Agent 01       │     │     Woodpecker Agent 02       │
│  (Docker / Podman / DinD)     │     │    (Bare Metal / GPU / K3s)   │
└───────────────────────────────┘     └───────────────────────────────┘
```

---

## 4. Edge Webhook Verification & Dispatcher

The Cloudflare Worker receives incoming Git webhooks, validates signatures using the Web Crypto API, and dispatches the build trigger through the Cloudflare Tunnel authenticated with Cloudflare Access Service Tokens:

```typescript
export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");

  if (!signature || !event) {
    return new Response("Missing required GitHub webhook headers", { status: 400 });
  }

  const payloadText = await request.text();

  // Validate HMAC SHA-256 signature using WebCrypto
  const isValid = await verifyHmacSha256(payloadText, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Forward verified webhook to Woodpecker Server behind Cloudflare Tunnel
  const targetUrl = `${env.CI_TUNNEL_HOST}/api/hook`;
  
  return fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": deliveryId || "",
      "X-Hub-Signature-256": signature,
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    },
    body: payloadText,
  });
}

async function verifyHmacSha256(payload: string, headerSig: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const parts = headerSig.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") return false;

  const sigHex = parts[1];
  const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);

  return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
}
```

---

## 5. Zero-Buffering SSE Live Log Stream Proxy

Woodpecker emits live logs over Server-Sent Events at `GET /api/stream/logs/{repo_id}/{pipeline}/{step_id}`. The Cloudflare Worker streams this response directly back to the browser dashboard without edge buffering:

```typescript
export async function handleLogStreamProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const subPath = url.pathname.replace("/api/ci/logs/", "");
  const [repoId, pipeline, stepId] = subPath.split("/");

  const upstreamUrl = `${env.CI_TUNNEL_HOST}/api/stream/logs/${repoId}/${pipeline}/${stepId}`;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${env.WOODPECKER_API_TOKEN}`,
      "Accept": "text/event-stream",
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    },
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return new Response(`Upstream CI error: ${upstreamResponse.statusText}`, {
      status: upstreamResponse.status,
    });
  }

  // Stream pass-through with no-buffering headers
  return new Response(upstreamResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
```
