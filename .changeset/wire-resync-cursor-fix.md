---
"@moonshot-ai/kimi-code": patch
---

Fix a rare case where a session's live updates could stop arriving for good after the server asked the client to resync, until the session was closed and reopened.
