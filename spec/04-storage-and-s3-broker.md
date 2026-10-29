# Storage Specification: Embedded S3 Broker & R2 Interface

## 1. Interface Scope

The storage subsystem inside `cfb-broker` provides dual-path object storage compatibility:
1. In-Process R2 Binding: Serves internal `env.MY_BUCKET` calls from `workerd`.
2. Standard S3 Protocol: Serves external S3 clients and AWS SDKs over the Cloudflare Tunnel hostname (`s3.infra.example.com`).

---

## 2. Supported S3 Protocol Operations

| Operation | HTTP Method & URI | Request Headers | Response |
| :--- | :--- | :--- | :--- |
| PutObject | `PUT /{bucket}/{key}` | `Content-Type`, `Content-Length`, `x-amz-meta-*` | HTTP 200 with `ETag` header |
| GetObject | `GET /{bucket}/{key}` | Optional `Range: bytes=start-end` | HTTP 200/206 with object body |
| HeadObject | `HEAD /{bucket}/{key}` | None | HTTP 200 with metadata headers |
| DeleteObject | `DELETE /{bucket}/{key}` | None | HTTP 204 No Content |
| ListObjectsV2 | `GET /{bucket}?list-type=2` | Optional `prefix`, `max-keys`, `continuation-token` | XML payload with key listings |

---

## 3. Storage Engine Mechanics

### File Layout
```
/var/lib/cfb-broker/s3-data/
  \-- <bucket>/
        |-- uploads/
        |     \-- .tmp-<uuid>          (active atomic writes)
        \-- <key>                      (committed object bytes)
```

### Streaming & Memory Bounds
- Request bodies are read in chunked 64 KiB buffers using `tokio::io::copy` and written directly to disk.
- Maximum resident memory used per concurrent upload stream: 64 KiB regardless of file size.
- Atomic commit: uploads write to `.tmp-<uuid>` and execute an atomic `rename()` system call once the SHA-256 and MD5 hashes are validated.

---

## 4. Presigned URL Protocol via Edge Worker

To eliminate edge memory constraints (Cloudflare Workers 128 MB isolate limit), file transfers stream directly between the client browser and `cfb-broker`.

```
[ Browser Client ]
        |
        | 1. POST /api/storage/presign
        v
[ Cloudflare Edge Worker ]  (Generates AWS SigV4 signed URL pointing to Tunnel)
        |
        | 2. Returns: https://s3.infra.example.com/artifacts/build.tar.gz?X-Amz-...
        v
[ Browser Client ]
        |
        | 3. PUT /artifacts/build.tar.gz (Streams directly to host NVMe)
        v
[ Cloudflare Tunnel Ingress ]
        |
        v
[ cfb-broker Embedded S3 Engine ]
```

### Worker Signing Implementation
```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export async function generateUploadUrl(env: Env, bucket: string, key: string): Promise<string> {
  const s3 = new S3Client({
    endpoint: "https://s3.infra.example.com",
    region: "auto",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  return await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 900,
  });
}
```
