---
"@moonshot-ai/kimi-code": patch
---

Fix host-side diagnostic logging being silently dropped on the wire transport (`kimi agents`): only the in-process SDK client configured the root logger, so every `log.*` call in agents mode — including the TUI's attach/archive failure records with full stacks — was a no-op and nothing ever reached `~/.kimi-code/logs/kimi-code.log`.
