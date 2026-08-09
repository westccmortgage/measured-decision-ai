import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "npm:@aws-sdk/client-s3@3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3";

export function awsObjectStore() {
  const region = Deno.env.get("AWS_S3_REGION");
  const bucket = Deno.env.get("AWS_S3_BUCKET");
  const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("AWS object storage is not configured");
  }
  return {
    bucket,
    client: new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

export async function signedObjectReadUrl(
  key: string,
  expiresIn = 900,
) {
  const { bucket, client } = awsObjectStore();
  return await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn },
  );
}

export {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  getSignedUrl,
  ListPartsCommand,
  UploadPartCommand,
};
