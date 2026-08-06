---
"@moonshot-ai/kimi-code": patch
---

Fix session resume (agents view attach, the session picker, `kimi --resume`) sometimes showing an empty chat, or missing recent activity such as a reply sent while a session was detached, until something else happened to refresh it. Resuming a session now always pulls its latest state from the server.
