---
"@moonshot-ai/kimi-code": patch
---

Fix a stale turn timer (e.g. "2m31s+") ticking over a freshly attached idle session: switching sessions reset the streaming phase but not the live activity pane, so the previous session's spinner kept counting from the moment you first attached while it was busy.
