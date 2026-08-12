---
"@moonshot-ai/kimi-code": patch
---

Fix a rare case where a session's live updates could stop arriving for good after the server asked the client to resync. If the resync itself fails, updates now resume automatically on the connection's next reconnect instead of staying stuck until the session was closed and reopened.
