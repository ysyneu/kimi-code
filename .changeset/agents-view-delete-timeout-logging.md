---
"@moonshot-ai/kimi-code": patch
---

Fix the agents view's Ctrl+X delete hanging silently forever when the server-side archive wedges (e.g. archiving a session whose turn won't settle): the delete RPC is now bounded like the reply/attach RPCs, so the row stays with a visible "Failed to archive session: …" flash carrying the reason instead of no feedback at all. Attach and archive failures also log the full error (stack included) to the diagnostic log — the roster flash truncates the reason on narrow terminals, leaving no way to diagnose a wedged resume after the fact.
