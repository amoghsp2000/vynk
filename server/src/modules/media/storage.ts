import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';

const common = {
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
};

/** Server-side operations (inside the private network). */
const internal = new S3Client({ ...common, endpoint: env.S3_ENDPOINT });
/** Only used to sign URLs that browsers will hit; signing happens locally. */
const publicSigner = new S3Client({ ...common, endpoint: env.S3_PUBLIC_ENDPOINT });

export async function presignUpload(key: string, contentType: string, maxBytes: number, expiresIn = 300) {
  return createPresignedPost(publicSigner, {
    Bucket: env.S3_BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: expiresIn,
  });
}

export async function presignDownload(key: string, contentType: string, expiresIn = 300) {
  return getSignedUrl(
    publicSigner,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: 'inline',
    }),
    { expiresIn },
  );
}

export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const r = await internal.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return { size: r.ContentLength ?? 0 };
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
    throw err;
  }
}

/** Reads the first bytes of an object for content sniffing. */
export async function readHead(key: string, bytes = 64): Promise<Buffer> {
  const r = await internal.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Range: `bytes=0-${bytes - 1}` }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

export async function deleteObject(key: string) {
  await internal.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/**
 * Creates the bucket if it doesn't exist (e.g. a fresh MinIO on a PaaS without
 * an init container). The bucket stays private: all access is presigned.
 */
export async function ensureBucket() {
  try {
    await internal.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status !== 404 && err?.name !== 'NotFound' && err?.name !== 'NoSuchBucket') throw err;
    await internal.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  }
}

/** Lets browsers on the app's origins upload (presigned POST) and read (presigned GET) directly. */
export async function configureBucketCors() {
  await internal.send(
    new PutBucketCorsCommand({
      Bucket: env.S3_BUCKET,
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: env.CORS_ORIGINS, AllowedMethods: ['GET', 'POST'], AllowedHeaders: ['*'], MaxAgeSeconds: 3600 }],
      },
    }),
  );
}
