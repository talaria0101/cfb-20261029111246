/**
 * Cloudflare Worker Edge Control Plane
 * Connects to unified cfb-broker host daemon over Cloudflare Tunnel
 * License: 0BSD
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface Env {
  // Cloudflare Tunnel endpoint pointing to cfb-broker
  BROKER_TUNNEL_HOST: string; // e.g. "https://broker.infra.yourdomain.com"

  // Cloudflare Access Service Token credentials
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;

  // S3 / R2 credentials
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;

  // Webhook secret
  GITHUB_WEBHOOK_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Common CORS headers for SPA dashboard
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Upgrade",
        },
      });
    }

    try {
      // ------------------------------------------------------------------------
      // 1. Topology & Infrastructure Graph (Homelable Pattern)
      // ------------------------------------------------------------------------
      if (url.pathname === "/api/topology" && request.method === "GET") {
        return await handleTopologyGraph(env);
      }

      // ------------------------------------------------------------------------
      // 2. Real-Time Telemetry Stream (from cfb-broker sysinfo probe)
      // ------------------------------------------------------------------------
      if (url.pathname === "/api/telemetry" && request.method === "GET") {
        return await fetch(`${env.BROKER_TUNNEL_HOST}/telemetry/sample`, {
          headers: getTunnelHeaders(env),
        });
      }

      // ------------------------------------------------------------------------
      // 3. Compute & Sandboxes (Proxied directly to cfb-broker)
      // ------------------------------------------------------------------------
      if (url.pathname === "/api/sandboxes/list" && request.method === "GET") {
        return await fetch(`${env.BROKER_TUNNEL_HOST}/docker/containers/json?all=1`, {
          headers: getTunnelHeaders(env),
        });
      }

      if (url.pathname === "/api/sandboxes/spawn" && request.method === "POST") {
        return await fetch(`${env.BROKER_TUNNEL_HOST}/docker/spawn`, {
          method: "POST",
          headers: getTunnelHeaders(env),
          body: request.body,
        });
      }

      // Interactive terminal bridge via WebSocket
      if (url.pathname.startsWith("/api/sandboxes/terminal/")) {
        const containerId = url.pathname.split("/")[4];
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected WebSocket upgrade", { status: 426 });
        }

        const wsUrl = new URL(env.BROKER_TUNNEL_HOST);
        wsUrl.protocol = "wss:";
        wsUrl.pathname = `/docker/containers/${containerId}/attach/ws`;
        wsUrl.search = "?stream=1&stdin=1&stdout=1&stderr=1";

        const originWsRes = await fetch(wsUrl.toString(), {
          headers: {
            Upgrade: "websocket",
            ...getTunnelHeaders(env),
          },
        });

        const serverSocket = originWsRes.webSocket;
        if (!serverSocket) {
          return new Response("Failed to attach to container terminal", { status: 502 });
        }

        const [client, worker] = Object.values(new WebSocketPair());
        worker.accept();
        serverSocket.accept();

        worker.addEventListener("message", (e) => serverSocket.send(e.data));
        serverSocket.addEventListener("message", (e) => worker.send(e.data));
        serverSocket.addEventListener("close", () => worker.close());
        worker.addEventListener("close", () => serverSocket.close());

        return new Response(null, { status: 101, webSocket: client });
      }

      // Web SFTP File Explorer (OmnySSH Pattern)
      if (url.pathname.startsWith("/api/sandboxes/files/")) {
        const parts = url.pathname.split("/");
        const containerId = parts[4];
        const filePath = url.searchParams.get("path") || "/workspace";

        return await fetch(
          `${env.BROKER_TUNNEL_HOST}/files/archive?id=${containerId}&path=${encodeURIComponent(filePath)}`,
          { headers: getTunnelHeaders(env) }
        );
      }

      // ------------------------------------------------------------------------
      // 4. Storage Plane: Presigned URLs for cfb-broker S3 Engine
      // ------------------------------------------------------------------------
      if (url.pathname === "/api/storage/presign" && request.method === "POST") {
        const { bucket, key, operation, contentType } = await request.json<{
          bucket: string;
          key: string;
          operation: "get" | "put";
          contentType?: string;
        }>();

        const s3 = new S3Client({
          endpoint: `${env.BROKER_TUNNEL_HOST}/s3`,
          region: "auto",
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY || "cfb_access_key",
            secretAccessKey: env.S3_SECRET_KEY || "cfb_secret_key",
          },
          forcePathStyle: true,
        });

        let command;
        if (operation === "put") {
          command = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: contentType || "application/octet-stream",
          });
        } else {
          command = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          });
        }

        const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
        return Response.json({ presignedUrl });
      }

      // ------------------------------------------------------------------------
      // 5. Heavy CI: Webhook Dispatch & Live SSE Log Proxy
      // ------------------------------------------------------------------------
      if (url.pathname === "/webhook/github" && request.method === "POST") {
        return await handleGitHubWebhook(request, env);
      }

      if (url.pathname.startsWith("/api/ci/logs/")) {
        const jobId = url.pathname.replace("/api/ci/logs/", "");
        const targetUrl = `${env.BROKER_TUNNEL_HOST}/ci/stream/${jobId}`;

        const upstreamResponse = await fetch(targetUrl, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            ...getTunnelHeaders(env),
          },
        });

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          return new Response(`Upstream CI error: ${upstreamResponse.statusText}`, {
            status: upstreamResponse.status,
          });
        }

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

      // ------------------------------------------------------------------------
      // 6. workerd Runtime & Durable Objects Gateway Proxy
      // ------------------------------------------------------------------------
      if (url.pathname.startsWith("/api/workerd/")) {
        const subPath = url.pathname.replace("/api/workerd", "");
        const targetUrl = new URL(subPath + url.search, `${env.BROKER_TUNNEL_HOST}/workerd`);

        const headers = new Headers(request.headers);
        headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
        headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
        headers.set("X-Forwarded-Host", url.hostname);

        return fetch(new Request(targetUrl.toString(), {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }));
      }

      return new Response("Not Found", { status: 404 });
    } catch (err: any) {
      return Response.json({ error: err.message || "Internal server error" }, { status: 500 });
    }
  },
};

function getTunnelHeaders(env: Env): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID || "",
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET || "",
  };
}

async function handleTopologyGraph(env: Env): Promise<Response> {
  let containers: any[] = [];
  try {
    const res = await fetch(`${env.BROKER_TUNNEL_HOST}/docker/containers/json?all=1`, {
      headers: getTunnelHeaders(env),
    });
    if (res.ok) {
      containers = await res.json();
    }
  } catch (_) {}

  const nodes = [
    { id: "cf-edge", label: "Cloudflare Edge (Workers/Pages)", type: "control-plane", status: "online" },
    { id: "cf-tunnel", label: "Cloudflare Tunnel (cfrs embedded)", type: "network", status: "online" },
    { id: "host-broker", label: "cfb-broker (<20MB Rust Daemon)", type: "host", status: "online" },
    { id: "svc-workerd", label: "workerd V8 Runtime (Drop-in Workers & SQLite DOs)", type: "runtime", status: "online" },
    { id: "svc-s3", label: "Embedded S3 Storage (Drop-in R2)", type: "storage", status: "online" },
    { id: "svc-ci", label: "Embedded CI Task Runner", type: "ci", status: "online" },
  ];

  const edges = [
    { from: "cf-edge", to: "cf-tunnel", protocol: "QUIC/HTTP3" },
    { from: "cf-tunnel", to: "host-broker", protocol: "mTLS/Tunnel" },
    { from: "host-broker", to: "svc-workerd" },
    { from: "host-broker", to: "svc-s3" },
    { from: "host-broker", to: "svc-ci" },
  ];

  containers.forEach((c) => {
    const cId = `container-${c.Id.substring(0, 12)}`;
    nodes.push({
      id: cId,
      label: `${c.Names?.[0] || c.Id.substring(0, 8)} (${c.Image})`,
      type: "sandbox",
      status: c.State === "running" ? "online" : "stopped",
    });
    edges.push({ from: "host-broker", to: cId });
  });

  return Response.json({ nodes, edges, generatedAt: new Date().toISOString() });
}

async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");

  if (!signature || !event) {
    return new Response("Missing required GitHub webhook headers", { status: 400 });
  }

  const payloadText = await request.text();

  if (env.GITHUB_WEBHOOK_SECRET) {
    const isValid = await verifyHmacSha256(payloadText, signature, env.GITHUB_WEBHOOK_SECRET);
    if (!isValid) {
      return new Response("Invalid signature", { status: 401 });
    }
  }

  // Forward verified webhook to cfb-broker embedded CI runner over Cloudflare Tunnel
  const targetUrl = `${env.BROKER_TUNNEL_HOST}/ci/dispatch`;
  return fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": deliveryId || "",
      "X-Hub-Signature-256": signature,
      ...getTunnelHeaders(env),
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
