---
"@moonshot-ai/kimi-code": patch
---

Fix `kimi --auto agents` (and `--yolo`/`--plan`) dropping the startup flags: sessions dispatched from the agents view now start in the startup permission mode, and attaching an existing session applies the startup permission/plan modes exactly like a main-shell resume.
