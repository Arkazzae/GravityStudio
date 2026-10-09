import { CreateBucketCommand, HeadBucketCommand, S3Client, type BucketLocationConstraint } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { S3ObjectStore, type S3ObjectStoreConfig } from "./object-store.ts";

/** Explicit provisioning only: ordinary application startup never creates buckets. */
export async function initializeObjectBucket(config: S3ObjectStoreConfig): Promise<void> {
  const store = new S3ObjectStore(config); // Validate before constructing an administrative client.
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 1,
    requestHandler: { connectionTimeout: 5000, socketTimeout: config.timeoutMs } });
  try {
    try { await client.send(new HeadBucketCommand({ Bucket: config.bucket }), { abortSignal: AbortSignal.timeout(config.timeoutMs) }); }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      await client.send(new CreateBucketCommand({ Bucket: config.bucket,
        ...(config.region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: config.region as BucketLocationConstraint } }),
      }), { abortSignal: AbortSignal.timeout(config.timeoutMs) });
    }
    const bytes = Buffer.from("Gravity Studio private storage check\n");
    for (const location of [`inputs/${randomUUID()}`, `outputs/${randomUUID()}/${randomUUID().replaceAll("-", "")}`]) {
      const ref = await store.put(location, bytes, "application/octet-stream");
      try {
        await store.get(ref, bytes.length);
        const url = new URL(`/${encodeURIComponent(config.bucket)}/${ref.key.split("/").map(encodeURIComponent).join("/")}`, config.endpoint);
        const anonymous = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(config.timeoutMs) });
        await anonymous.body?.cancel();
        if (![401, 403, 404].includes(anonymous.status)) throw new Error("The asset prefix must reject anonymous reads.");
      }
      finally { await store.delete(ref); }
    }
  } catch {
    throw new Error("Could not initialize and verify the private S3 bucket. Check the endpoint, credentials and bucket permissions.");
  } finally { client.destroy(); store.close(); }
}
