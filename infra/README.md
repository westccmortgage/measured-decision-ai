# The parts of this system that do not live in this repository

Everything here is configuration that runs in somebody else's console — AWS,
Netlify, Supabase — and that the code depends on absolutely. It is written
down because the one piece that was not written down is the one that broke.

## s3-evidence-cors.json — the evidence bucket's CORS policy

**What it is for.** The browser talks to S3 directly for two things, and both
of them are refused by a bucket that does not name the site's origin:

- **Uploading.** Each part of a multipart upload is a `PUT` the browser sends
  straight to S3 with a pre-signed URL. A CORS refusal reaches
  `XMLHttpRequest` as an `error` event with no status and no body, and the
  uploader can only report it as `Network connection was interrupted` at 0%.
  There is nothing more truthful it can say: the browser does not tell the
  page that the refusal was CORS.
- **Reading a video for AI keyframes.** `extractVideoFrames` loads the capture
  into a `<video crossOrigin="anonymous">` and draws it onto a canvas. Without
  a matching `Access-Control-Allow-Origin` the load fails and the page reports
  `The video could not be decoded for AI keyframes`. The file is perfectly
  good; the browser was simply not allowed to read it.

`ExposeHeaders` matters as much as the origins. The uploader reads `ETag` off
each part to complete the multipart upload, and keyframe extraction seeks
through the video, which needs range responses — so `ETag`, `Content-Range`
and `Accept-Ranges` have to be exposed or the browser cannot see them even on
a request that succeeded.

**How this broke.** The site moved from `measureddecision.com` to
`measureddecision.ai`. The Supabase functions carried an origin allowlist
that moved with the code once it was found; this bucket policy lives in the
AWS console, was written down nowhere, and did not move. Every upload and
every AI read failed, each with a message that named a symptom rather than
the cause.

**How to apply it.**

    aws s3api put-bucket-cors \
      --bucket "$AWS_S3_BUCKET" \
      --cors-configuration file://infra/s3-evidence-cors.json

Or in the console: S3 → the evidence bucket → Permissions →
Cross-origin resource sharing (CORS) → Edit → paste this file → Save.

To read back what the bucket currently believes:

    aws s3api get-bucket-cors --bucket "$AWS_S3_BUCKET"

**When the prime domain changes again**, this file changes with it, in the
same commit as `netlify.toml` and the functions — and it is applied to the
bucket by hand, because nothing in this repository holds AWS credentials.
`studio/tests/prime-domain-reaches-the-cloud.mjs` holds this file to the
prime domain named in the redirects, so the commit cannot forget it. It
cannot check the live bucket; that part is yours.
