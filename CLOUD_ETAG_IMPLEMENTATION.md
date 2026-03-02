# Cloud ETag Implementation Prompt

**Task: Implement ETag Support for GET /sessions Endpoint**

**Context:**
The Edge application polls `GET /sessions?device_ids=...` with adaptive intervals (5–120s) to check for active sessions. Most polls return the same data, wasting Cloud Run CPU and billing. We need to implement HTTP ETag caching to return `304 Not Modified` when session data hasn't changed.

**Requirements:**

1. **Generate ETag from session data**
   - Compute a hash (MD5 or SHA256) of the session response payload
   - Format: `"sessions-{hash}"` (weak ETag) or use `W/"sessions-{hash}"`
   - ETag must change when ANY session field changes (status, deviceId, animalId, etc.)
2. **Handle If-None-Match header**
   - Check incoming `If-None-Match` request header
   - If it matches current ETag, return `304 Not Modified` with empty body
   - If no match or no header, return full `200 OK` response with `ETag` header
3. **Response headers**
   - Always include `ETag: "sessions-{hash}"` header on 200 responses
   - Include `Cache-Control: no-cache` (client must revalidate, but can use ETag)

**Implementation pseudocode:**

```typescript
// In your sessions controller/handler
async function getSessions(req, res) {
  const deviceIds = req.query.device_ids?.split(",") ?? [];
  
  // Fetch sessions from database
  const sessions = await fetchActiveSessions(deviceIds);
  
  // Compute ETag from response payload
  const payload = JSON.stringify({ sessions });
  const hash = crypto.createHash("md5").update(payload).digest("hex").slice(0, 16);
  const etag = `"sessions-${hash}"`;
  
  // Check If-None-Match
  const clientETag = req.headers["if-none-match"];
  if (clientETag === etag) {
    return res.status(304).end(); // No body, minimal CPU
  }
  
  // Return full response with ETag
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache");
  return res.json({ sessions });
}
```

**Testing:**

1. First request: Should return 200 with ETag header
2. Second request with `If-None-Match: {etag}`: Should return 304 (empty body)
3. After session changes: Should return 200 with new ETag

**Expected outcome:**

- 304 responses use minimal Cloud Run CPU (no JSON serialization, no body)
- Edge receives instant "no change" signal instead of full payload
- Cloud Run costs reduced by 80–95% for session polling
