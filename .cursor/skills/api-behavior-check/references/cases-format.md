# cases.json format
```json
{
  "name": "issue-18-malformed-target",
  "ticket": "https://github.com/owner/repo/issues/N",
  "fixture": [ { "method": "POST", "path": "/v1/collections", "body": {"name":"orders","fields":{"status":"string"}} } ],
  "cases": [
    {
      "id": "short-id", "criterion": "AC1", "desc": "what and why",
      "method": "GET",
      "path": "/v1/collections/orders/records",   // or "rawTarget": "http://[::1" sent byte-for-byte, no normalisation
      "auth": "valid",                            // valid (default) | none | literal header value (may use ${KEY})
      "headers": { "x-test": "1" },
      "body": { "any": "json" },                  // object (sent as JSON) or raw string
      "expect": {
        "status": 401,                            // number, or [401, 400] for "either"; REQUIRED
        "body": { "error.code": "unauthenticated" },   // dot paths; value, ["a","b"] = any of, "*" = exists, null = absent; REQUIRED for >=400
        "errorShape": true,                       // body must be {"error":{"code":string,"message":string}}
        "serverLogMustNotMatch": ["TypeError"],   // regexes against server stderr/stdout produced during this request
        "allowNotFound": false                    // set true only if a 404/405 is not an "endpoint missing" signal
      }
    }
  ]
}
```
- `fixture` steps run first with a valid key and must return 2xx or the run aborts (exit 3).
- Options: `--out DIR`, `--base-url URL` (use an already running server; then pass `--key`), env `CHECK_COMMIT`.
- Each case with missing expectations makes the runner exit 2 (`NEEDS INPUT`) before sending anything.
