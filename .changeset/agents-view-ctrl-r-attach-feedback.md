---
"@moonshot-ai/kimi-code": patch
---

Fix agents view keyboard dead-ends that read as a frozen UI: Ctrl+R now opens rename for the selected session even while the dispatch composer is focused (previously the key was swallowed by the editor), and attaching a session shows an "Attaching session…" indicator for the whole bounded wait instead of a silent, apparently stuck roster.
