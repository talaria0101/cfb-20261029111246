# Storage Plane: Embedded S3 Broker & Drop-In R2 Compatibility

## 1. The R2 Drop-In Requirement

Cloudflare R2 serves two access patterns:
1. **In-Worker Bindings**: `await env.MY_BUCKET.put(key, stream)` and `await env.MY_BUCKET.get(key)`.
2. **External S3 Clients**: Applications using `@aws-sdk/client-s3`, AWS CLI, Terraform, or rclone.

To replace R2 without running heavy external object stores (like MinIO consuming 2–4 GiB RAM), **`cfb-broker` embeds a lightweight S3-compatible storage engine directly in Rust**.

---

## 2. Architecture of the Embedded S3 Broker

```
                                  PUBLIC CLIENTS / BROWSERS
                                              │
                     ┌────────────────────────┴────────────────────────┐
                     │                                                 │
            1. Request Presigned URL                          2. Direct Upload via S3
                     │                                                 │
                     ▼                                                 ▼
       ┌───────────────────────────┐                     ┌───────────────────────────┐
       │ Cloudflare Edge Worker    │                     │  Cloudflare Tunnel Ingress│
       │ (Signs AWS SigV4 URL)     │                     │  (s3.infra.yourdomain.com)│
       └───────────────────────────┘                     └─────────────┬─────────────┘
                                                                       │
 ══════════════════════════════════════════════════════════════════════╪══════════════════════
                               HOST SERVER (cfb-broker)                │
 ══════════════════════════════════════════════════════════════════════╪══════════════════════
                                                                       ▼
                                 ┌───────────────────────────────────────────────────────────┐
                                 │ cfb-broker: Embedded S3 Engine                            │
                                 │                                                           │
                                 │ • Validates AWS SigV4 signatures (or bypasses via Access) │
                                 │ • Streams object bodies directly to NVMe disk             │
                                 │ • Atomic writes using temp files (.tmp-*) + rename        │
                                 │ • Maintains metadata in SQLite: bucket, key, etag, size   │
                                 └──────────────┬─────────────────────────────┬──────────────┘
                                                │                             │
                                                ▼                             ▼
                          ┌───────────────────────────┐ ┌───────────────────────────┐
                          │ Local Filesystem (NVMe)   │ │ workerd R2 Binding Bridge │
                          │ /var/lib/cfb-broker/s3/   │ │ env.MY_BUCKET.get/put     │
                          │   └── artifacts/          │ │ (Mapped directly to disk) │
                          │       └── build-123.tar.gz│ │                           │
                          └───────────────────────────┘ └───────────────────────────┘
```

---

## 3. Supported S3 API Endpoints in `cfb-broker`

The embedded S3 broker implements core S3 primitives:
- `PUT /{bucket}/{key}`: Uploads object stream; computes MD5/SHA256 ETag; stores file atomically.
- `GET /{bucket}/{key}`: Streams object with HTTP `Range` request support for resumable downloads.
- `HEAD /{bucket}/{key}`: Returns `ETag`, `Content-Length`, `Content-Type`, and metadata headers.
- `DELETE /{bucket}/{key}`: Removes file and metadata record.
- `GET /{bucket}?list-type=2`: S3 ListObjectsV2 XML response supporting prefixes and pagination.

### Zero-Memory Streaming
Large multi-gigabyte ISOs or container tarballs are piped directly from the async HTTP request stream into local storage using `tokio::fs::File`, using a constant **64 KiB buffer**. Memory usage never increases regardless of object file size.

---

## 4. In-Worker R2 Binding: Zero Code Changes

Inside `workerd`, Cloudflare's C++ runtime translates `env.MY_BUCKET.put(key, body)` into an internal HTTP binding request. `cfb-broker` bridges this binding directly to the local S3 directory:

```javascript
// This exact code runs in Cloudflare edge (native R2) AND on cfb-broker (local NVMe)
export default {
  async fetch(request, env) {
    if (request.method === "PUT") {
      // Writes directly to local disk on cfb-broker; writes to R2 on Cloudflare
      await env.ARTIFACTS.put("release.tar.gz", request.body, {
        httpMetadata: { contentType: "application/gzip" }
      });
      return new Response("Uploaded", { status: 201 });
    }

    const obj = await env.ARTIFACTS.get("release.tar.gz");
    return new Response(obj.body);
  }
};
```

---

## 5. Direct Browser Uploads via Presigned URLs

To bypass Cloudflare Worker 128 MB memory limits, the edge Worker signs presigned URLs pointing through the tunnel directly to `cfb-broker`:

```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export async function createPresignedUpload(env: Env, bucket: string, key: string): Promise<string> {
  const s3 = new S3Client({
    endpoint: "https://s3.infra.yourdomain.com",
    region: "auto",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  return await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 900, // 15 minutes
  });
}
```

The browser uploads directly through the Cloudflare Tunnel into the host's NVMe drive with zero intermediate buffering.
