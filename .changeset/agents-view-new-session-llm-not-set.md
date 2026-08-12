---
"@moonshot-ai/kimi-code": patch
---

Fix the first message in a freshly created agents-view session failing with `LLM not set, send "/login" to login` despite a configured default model: attaching a not-yet-bound session no longer wipes the client's model state, and explicit model/thinking/permission options passed to session creation are now forwarded on the wire transport instead of being dropped.
