# Storage Plane: Self-Hosted R2 and Durable Object Alternatives

## 1. Storage Matrix: Replacing Cloudflare R2

Cloudflare R2 provides an S3-compatible interface with zero egress fees, but high-volume Class A operations ($4.50/M) and storage charges ($0.015/GB/mo) can become expensive when storing build caches, continuous database WAL files, or large container artifacts.

### 1.1 In-Depth Comparison of Self-Hosted S3 Systems

| Attribute | Garage S3 ([deuxfleurs-org/garage](https://github.com/deuxfleurs-org/garage)) | SeaweedFS ([seaweedfs/seaweedfs](https://github.com/seaweedfs/seaweedfs)) | MinIO ([minio/minio](https://github.com/minio/minio)) |
| :--- | :--- | :--- | :--- |
| **Language** | **Rust** | **Go** | Go |
| **License** | **AGPLv3** | **Apache 2.0** | AGPLv3 (Strict compliance enforcement) |
| **Idle Memory** | **~40–80 MiB RAM** | ~200–500 MiB RAM | **2–16 GiB+ RAM** |
| **WAN Resilience** | **Superior** (Dynamo/CRDT, high latency tolerance) | Moderate (Async cross-DC replication) | **Fragile** (Synchronous erasure coding stalls over WAN) |
| **Architecture** | Single static binary; hash ring with bounded CRDTs | Decoupled Master (Raft) + Volume + S3 Filer | Single binary (inflexible disk topologies) |
| **Small File I/O** | Filesystem blocks with Zstandard compression | **Exceptional** (Haystack $O(1)$ volume needle packing) | Good (Inline small files in metadata) |
| **Ideal For** | **Multi-node, mixed VPS, home lab, low-RAM nodes** | **Data lakes, billions of small files, high throughput** | Enterprise on-premise high-memory LAN clusters |

### 1.2 Why Garage S3 is the Recommended Default
For developers running on mixed infrastructure (e.g. 1 Hetzner bare-metal + 1 cheap VPS + 1 home server):
- **Partition Tolerance**: Garage is explicitly built for unreliable networks. When a link drops between nodes, reads and writes continue using local quorums and converge automatically once the partition heals.
- **Resource Footprint**: Consumes less than 100MB of RAM on a 1-core VPS, compared to MinIO which demands gigabytes.
- **Simplicity**: No external database or complex microservices; metadata lives in embedded LMDB or SQLite.

#### Production Garage Configuration (`/etc/garage.toml`)
```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"

replication_factor = 3
consistency_mode = "consistent"

block_size = "1M"
block_ram_buffer_max = "256MiB"
compression_level = 1

rpc_secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
rpc_bind_addr = "0.0.0.0:3901"
rpc_public_addr = "10.0.0.1:3901"

[s3_api]
api_bind_addr = "127.0.0.1:3900"
s3_region = "garage"
root_domain = ".s3.internal"

[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token = "SUPER_SECURE_ADMIN_SECRET_KEY"
```

---

## 2. Edge-Assisted S3 Presigning via Cloudflare Workers

Cloudflare Workers enforce a **128 MB default memory limit**. Streaming 5 GB ISOs or container tarballs directly through a Worker will exhaust worker memory.

### The Direct Presigned Pattern
1. The client requests an upload or download URL from the Cloudflare Worker API.
2. The Worker signs an AWS SigV4 URL pointing to the Cloudflare Tunnel hostname (`https://storage.infra.example.com`).
3. The client uploads or downloads directly to Garage S3 over Cloudflare Tunnel, completely bypassing Worker execution limits:

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface Env {
  STORAGE_TUNNEL_HOST: string; // https://storage.infra.example.com
  GARAGE_ACCESS_KEY: string;
  GARAGE_SECRET_KEY: string;
}

export async function generatePresignedUploadUrl(
  env: Env,
  bucket: string,
  key: string,
  contentType: string
): Promise<string> {
  const s3 = new S3Client({
    endpoint: env.STORAGE_TUNNEL_HOST,
    region: "garage",
    credentials: {
      accessKeyId: env.GARAGE_ACCESS_KEY,
      secretAccessKey: env.GARAGE_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  // Generates 15-minute temporary upload URL
  return await getSignedUrl(s3, command, { expiresIn: 900 });
}
```

---

## 3. Stateful Coordination & Durable Object Alternatives

Durable Objects offer two core guarantees:
1. **Singleton Actor Execution**: Exactly one instance of an actor exists globally per ID.
2. **Co-located Transactional Persistence**: Embedded transactional database per actor instance.

### 3.1 Option A: Native `workerd` with SQLite Persistence
As detailed in `spec/03`, running `cloudflare/workerd` on the host machine gives full, native support for Cloudflare Durable Objects backed by **local SQLite files** (`localDisk`).

### 3.2 Option B: Multi-Tenant SQLite with `libSQL/sqld`
If decoupling database state from compute, [tursodatabase/libsql](https://github.com/tursodatabase/libsql) (`sqld`) provides per-tenant SQLite isolation with cloud replication:
- **Namespaces**: Host tens of thousands of isolated SQLite databases on a single server using `x-namespace: <tenant-or-room-id>` headers.
- **Hrana Protocol**: Connects over WebSockets or HTTP, with first-class `@libsql/client` drivers running inside Cloudflare Workers.
- **Bottomless Replication**: Automatically replicates committed WAL frames to Garage S3. If the host burns down, zero transactions are lost.

### 3.3 Option C: Open-Source Actor Engines (Rivet Actors)
[rivet-dev/rivet](https://github.com/rivet-dev/rivet) is an open-source platform specifically engineered as a self-hosted alternative to Cloudflare Durable Objects:
- **Fast Startup**: 6.9 ms cold starts using V8 isolates.
- **Persistent State**: State auto-commits to KV or SQLite.
- **Hibernation**: Automatically sleeps actors when no WebSocket connections are active.
- **Dynamic Routing**: Internal router proxies incoming requests to whichever server currently holds the actor singleton.
