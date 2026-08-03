#!/usr/bin/env node
/**
 * Audit or provision the private Phase 5 snapshot bucket via the Storage API.
 *
 * Default is read-only. Pass --apply only after the owner approves the exact
 * live mutation. No key value, signed URL, object name, or snapshot body is
 * printed.
 */
import { createClient } from "@supabase/supabase-js";

const BUCKET = "search-answer-snapshots";
const FILE_SIZE_LIMIT = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["application/gzip"];
const apply = process.argv.includes("--apply");
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error("Snapshot storage audit requires SUPABASE_URL and SUPABASE_SERVICE_KEY.");
  process.exit(2);
}

const client = createClient(url, key, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const { data: existing, error: readError } = await client.storage.getBucket(BUCKET);

if (readError && !/not found/i.test(readError.message || "")) {
  console.error("Could not audit the snapshot bucket.");
  process.exit(1);
}

if (!existing) {
  if (!apply) {
    console.log(JSON.stringify({
      bucket: BUCKET,
      exists: false,
      mutationRequired: true,
      requestedConfig: {
        public: false,
        fileSizeLimit: FILE_SIZE_LIMIT,
        allowedMimeTypes: ALLOWED_MIME_TYPES,
      },
    }, null, 2));
    process.exit(3);
  }
  const { error } = await client.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: FILE_SIZE_LIMIT,
    allowedMimeTypes: ALLOWED_MIME_TYPES,
  });
  if (error) {
    console.error("Could not create the private snapshot bucket.");
    process.exit(1);
  }
}

const { data: verified, error: verifyError } = await client.storage.getBucket(BUCKET);
if (verifyError || !verified) {
  console.error("Snapshot bucket verification failed.");
  process.exit(1);
}
const mimeTypes = [...(verified.allowed_mime_types ?? [])].sort();
const valid = verified.public === false
  && Number(verified.file_size_limit) === FILE_SIZE_LIMIT
  && JSON.stringify(mimeTypes) === JSON.stringify([...ALLOWED_MIME_TYPES].sort());

console.log(JSON.stringify({
  bucket: BUCKET,
  exists: true,
  private: verified.public === false,
  fileSizeLimit: verified.file_size_limit,
  allowedMimeTypes: mimeTypes,
  valid,
}, null, 2));
process.exit(valid ? 0 : 1);
