/**
 * Cloudflare Worker Edge Control Plane
 * Orchestrates remote compute, storage, and CI over Cloudflare Tunnels
 * License: 0BSD
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface Env {
  // Cloudflare Tunnel endpoints
  DOCKER_TUNNEL_HOST: string;
  STORAGE_TUNNEL_HOST: string;
  WORKERD_TUNNEL_HOST: string;
  CI_TUNNEL_HOST: string;

  // Cloudflare Access Service Token credentials
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;

  // Storage credentials
  GARAGE_ACCESS_KEY?: string;
  GARAGE_SECRET_KEY?: string;

  // CI credentials
  GITHUB_WEBHOOK_SECRET?: string;
  WOODPECKER_API_TOKEN?: string;
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
      // ────────────────────────────────────────────────────────────────────────
      // 1. Compute & Sandbox Management (Docker Socket Proxy over Tunnel)
      // ────────────────────────────────────────────────────────────────────────
      if (url.pathname === "/api/sandboxes/list" && request.method === "GET") {
        return await proxyDocker(env, "/v1.44/containers/json?all=1", "GET");
      }

      if (url.pathname === "/api/sandboxes/spawn" && request.method === "POST") {
        const body = await request.json<{ image: string; cmd?: string[]; memLimitMb?: number }>();
        const image = body.image || "alpine:latest";
        const memLimit = (body.memLimitMb || 512) * 1024 * 1024;

        // 1. Create container with resource constraints
        const createRes = await fetch(`${env.DOCKER_TUNNEL_HOST}/v1.44/containers/create`, {
          method: "POST",
          headers: getTunnelHeaders(env),
          body: JSON.stringify({
            Image: image,
            Cmd: body.cmd || ["/bin/sh"],
            Tty: true,
            OpenStdin: true,
            HostConfig: {
              Runtime: "runsc", // gVisor isolation (if configured on host)
              Memory: memLimit,
              NanoCpus: 1000000000, // 1 vCPU
            },
          }),
        });

        if (!createRes.ok) {
          return new Response(await createRes.text(), { status: createRes.status });
        }

        const { Id: containerId } = await createRes.json<{ Id: string }>();

        // 2. Start container
        await fetch(`${env.DOCKER_TUNNEL_HOST}/v1.44/containers/${containerId}/start`, {
          method: "POST",
          headers: getTunnelHeaders(env),
        });

        return Response.json({ success: true, containerId });
      }

      // Interactive terminal bridge via Docker WebSocket attach API
      if (url.pathname.startsWith("/api/sandboxes/terminal/")) {
        const containerId = url.pathname.split("/")[4];
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected WebSocket upgrade", { status: 426 });
        }

        const wsUrl = new URL(env.DOCKER_TUNNEL_HOST);
        wsUrl.protocol = "wss:";
        wsUrl.pathname = `/v1.44/containers/${containerId}/attach/ws`;
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

      // ────────────────────────────────────────────────────────────────────────
      // 2. Storage Plane: Presigned URLs for Garage S3
      // ────────────────────────────────────────────────────────────────────────
      if (url.pathname === "/api/storage/presign" && request.method === "POST") {
        const { bucket, key, operation, contentType } = await request.json<{
          bucket: string;
          key: string;
          operation: "get" | "put";
          contentType?: string;
        }>();

        const s3 = new S3Client({
          endpoint: env.STORAGE_TUNNEL_HOST,
          region: "garage",
          credentials: {
            accessKeyId: env.GARAGE_ACCESS_KEY || "dummy",
            secretAccessKey: env.GARAGE_SECRET_KEY || "dummy",
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

      // ────────────────────────────────────────────────────────────────────────
      // 3. Heavy CI: Webhook Ingress & Live SSE Log Proxy
      // ────────────────────────────────────────────────────────────────────────
      if (url.pathname === "/webhook/github" && request.method === "POST") {
        return await handleGitHubWebhook(request, env);
      }

      if (url.pathname.startsWith("/api/ci/logs/")) {
        const subPath = url.pathname.replace("/api/ci/logs/", "");
        const [repoId, pipeline, stepId] = subPath.split("/");

        const targetUrl = `${env.CI_TUNNEL_HOST}/api/stream/logs/${repoId}/${pipeline}/${stepId}`;
        const upstreamResponse = await fetch(targetUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.WOODPECKER_API_TOKEN}`,
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

      // ────────────────────────────────────────────────────────────────────────
      // 4. workerd Runtime & Durable Objects Gateway Proxy
      // ────────────────────────────────────────────────────────────────────────
      if (url.pathname.startsWith("/api/workerd/")) {
        const subPath = url.pathname.replace("/api/workerd", "");
        const targetUrl = new URL(subPath + url.search, env.WORKERD_TUNNEL_HOST);

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

async function proxyDocker(env: Env, path: string, method: string): Promise<Response> {
  const targetUrl = `${env.DOCKER_TUNNEL_HOST}${path}`;
  const res = await fetch(targetUrl, {
    method,
    headers: getTunnelHeaders(env),
  });
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
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

  // Forward verified webhook to Woodpecker Server behind Cloudflare Tunnel
  const targetUrl = `${env.CI_TUNNEL_HOST}/api/hook`;
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
