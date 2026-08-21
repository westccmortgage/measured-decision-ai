(function initializeMeasuredDecisionObjectStorage() {
  const FUNCTION_NAME = "object-storage";
  const SIGN_BATCH_SIZE = 24;
  const CONCURRENCY = 3;
  const RETRY_DELAYS = [0, 1000, 3000, 7000, 15000];

  function humanBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes || 0);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  async function invoke(client, payload) {
    const { data, error } = await client.functions.invoke(FUNCTION_NAME, { body: payload });
    if (error) {
      let message = error?.message || "Secure object-storage request failed";
      try {
        const response = error?.context;
        if (response?.clone) {
          const detail = await response.clone().json();
          if (detail?.error) message = detail.error;
        }
      } catch {
        // Preserve the SDK error when the response body is not JSON.
      }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  function fingerprint(entityType,organizationId,propertyId,file,fieldAccess,captureAccess,projectAccess){return["mdai-s3-upload-v3",entityType,organizationId,propertyId,fieldAccess?.assignment_id||captureAccess?.session_id||projectAccess?.code||"account",file.name,file.size,file.lastModified||0].join(":")}

  function readSession(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      return parsed?.session_id ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveSession(key, sessionId) {
    localStorage.setItem(key, JSON.stringify({ session_id: sessionId, saved_at: Date.now() }));
  }

  function clearSession(key) {
    localStorage.removeItem(key);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function putPart(url, blob, onBytes) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("PUT", url, true);
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onBytes(event.loaded);
      });
      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) {
          const etag = request.getResponseHeader("ETag");
          if (!etag) return reject(new Error("S3 completed a part without returning its ETag"));
          onBytes(blob.size);
          return resolve(etag);
        }
        reject(new Error(`S3 rejected an upload part (${request.status})`));
      });
      request.addEventListener("error", () => reject(new Error("Network connection was interrupted")));
      request.addEventListener("abort", () => reject(new Error("Upload was cancelled")));
      request.send(blob);
    });
  }

  async function putWithRetry(url, blob, onBytes) {
    let lastError;
    for (const wait of RETRY_DELAYS) {
      if (wait) await delay(wait);
      try {
        return await putPart(url, blob, onBytes);
      } catch (error) {
        lastError = error;
        if (!navigator.onLine) await delay(2000);
      }
    }
    throw lastError || new Error("Upload part failed");
  }

  /* A real digest of the whole file, for files small enough to read twice on a
     phone. Photos and documents — the great majority of evidence — fall well
     under this; a 40 GB camera original does not, and gets its digest later
     from the stitching machine, which has to read all of it anyway.

     Web Crypto has no incremental digest, so this reads the file into one
     buffer. 64 MiB is chosen to stay comfortably inside what a mid-range phone
     will allocate without the tab being killed mid-upload. */
  const WHOLE_FILE_HASH_LIMIT = 64 * 1024 * 1024;

  async function wholeFileDigest(file) {
    if (!file || file.size > WHOLE_FILE_HASH_LIMIT) return null;
    if (!window.crypto?.subtle || !file.arrayBuffer) return null;
    try {
      const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (error) {
      /* Never let integrity metadata cost somebody their upload. Without it the
         record simply says no whole-file digest was taken, which is true. */
      console.warn("Could not compute a file digest; the upload continues without one", error);
      return null;
    }
  }

  async function upload(options) {
    const {
      client, entityType, organizationId, propertyId, spaceId = null,
      file, metadata = {}, fieldAccess = null, captureAccess = null, projectAccess = null, onProgress = () => undefined,
    } = options;
    if (!client || !file || !organizationId || !propertyId) throw new Error("Upload context is incomplete");

    const storageKey=fingerprint(entityType,organizationId,propertyId,file,fieldAccess,captureAccess,projectAccess);
    const authorized = (payload) => fieldAccess
      ? { ...payload, field_access: fieldAccess }
      : captureAccess
      ? { ...payload, capture_access: captureAccess }
      : projectAccess ? {...payload,project_access:projectAccess}
      : payload;
    const prior = readSession(storageKey);
    let session;
    let resumed = false;
    if (prior) {
      try {
        session = await invoke(client, authorized({ operation: "resume_upload", session_id: prior.session_id }));
        if (session.status === "completed" && session.record) {
          clearSession(storageKey);
          onProgress({ stage: "complete", percent: 100, uploadedBytes: file.size, totalBytes: file.size, resumed: true, label: `${humanBytes(file.size)} of ${humanBytes(file.size)}` });
          return { record: session.record, signed_url: session.signed_url || "" };
        }
        resumed = true;
      } catch (error) {
        console.warn("Stored upload session is no longer reusable", error);
        clearSession(storageKey);
      }
    }
    if (!session) {
      session = await invoke(client, authorized({
        operation: "create_upload",
        entity_type: entityType,
        organization_id: organizationId,
        property_id: propertyId,
        space_id: spaceId,
        file: { name: file.name, type: file.type || "application/octet-stream", size: file.size, last_modified: file.lastModified || null },
        metadata: { ...metadata, content_sha256: await wholeFileDigest(file) },
      }));
      saveSession(storageKey, session.session_id);
    }

    const partSize = Number(session.part_size);
    const totalParts = Math.ceil(file.size / partSize);
    const completed = new Map((session.completed_parts || []).map((part) => [Number(part.part_number), {
      part_number: Number(part.part_number), etag: part.etag, size: Number(part.size || partSize),
    }]));
    let committedBytes = [...completed.values()].reduce((sum, part) => sum + Math.min(part.size, file.size - ((part.part_number - 1) * partSize)), 0);
    const activeBytes = new Map();
    const report = (stage = "uploading") => {
      const active = [...activeBytes.values()].reduce((sum, value) => sum + value, 0);
      const uploadedBytes = Math.min(file.size, committedBytes + active);
      const percent = stage === "complete" ? 100 : Math.min(99, Math.round((uploadedBytes / file.size) * 100));
      onProgress({ stage, percent, uploadedBytes: stage === "complete" ? file.size : uploadedBytes, totalBytes: file.size, resumed, label: stage === "finalizing" ? "Verifying and saving record" : `${humanBytes(stage === "complete" ? file.size : uploadedBytes)} of ${humanBytes(file.size)}` });
    };
    report(resumed ? "resuming" : "uploading");

    const missing = [];
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) if (!completed.has(partNumber)) missing.push(partNumber);

    for (let batchStart = 0; batchStart < missing.length; batchStart += SIGN_BATCH_SIZE) {
      const batch = missing.slice(batchStart, batchStart + SIGN_BATCH_SIZE);
      const signed = await invoke(client, authorized({ operation: "sign_parts", session_id: session.session_id, part_numbers: batch }));
      const urlByPart = new Map((signed.urls || []).map((item) => [Number(item.part_number), item.url]));
      let next = 0;
      async function worker() {
        while (next < batch.length) {
          const index = next;
          next += 1;
          const partNumber = batch[index];
          const start = (partNumber - 1) * partSize;
          const end = Math.min(file.size, start + partSize);
          const blob = file.slice(start, end);
          activeBytes.set(partNumber, 0);
          const etag = await putWithRetry(urlByPart.get(partNumber), blob, (loaded) => {
            activeBytes.set(partNumber, loaded);
            report("uploading");
          });
          activeBytes.delete(partNumber);
          completed.set(partNumber, { part_number: partNumber, etag, size: blob.size });
          committedBytes += blob.size;
          report("uploading");
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
    }

    report("finalizing");
    const result = await invoke(client, authorized({
      operation: "complete_upload",
      session_id: session.session_id,
      parts: [...completed.values()].sort((a, b) => a.part_number - b.part_number),
    }));
    clearSession(storageKey);
    report("complete");
    return result;
  }

  async function getSignedUrl(client, entityType, recordId, captureAccess = null) {
    const payload = { operation: "get_url", entity_type: entityType, record_id: recordId };
    const data = await invoke(client, captureAccess ? { ...payload, capture_access: captureAccess } : payload);
    return data.signed_url || "";
  }

  async function removeCaptureEvidence(client, recordId, captureAccess) {
    return await invoke(client, {
      operation: "remove_capture_evidence",
      record_id: recordId,
      capture_access: captureAccess,
    });
  }

  async function deleteEvidence(client, recordId) {
    return await invoke(client, { operation: "delete_evidence", record_id: recordId });
  }

  async function deleteProjectDocument(client, recordId) {
    return await invoke(client, { operation: "delete_project_document", record_id: recordId });
  }

  window.MDAIObjectStorage = { upload, getSignedUrl, removeCaptureEvidence, deleteEvidence, deleteProjectDocument, humanBytes };
})();
