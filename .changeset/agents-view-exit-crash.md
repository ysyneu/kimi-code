---
"@moonshot-ai/kimi-code": patch
---

Fix kimi agents crashing with an "Agent loop disposed" dump on exit: stray shutdown rejections now exit cleanly, and a goal continuation whose turn assignment is rejected pauses the goal instead of leaking an unhandled rejection.
