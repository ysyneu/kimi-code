---
"@moonshot-ai/kimi-code": patch
---

Fix an undone prompt's interruption reminder still showing in message history: cancelling a turn appends a reminder message after the prompt, and history folding failed to cut it together with the undone turn.
