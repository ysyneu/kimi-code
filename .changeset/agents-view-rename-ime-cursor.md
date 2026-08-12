---
"@moonshot-ai/kimi-code": patch
---

Agents view: fix the IME candidate window appearing at the end of the line while renaming a session with a Chinese (or other IME) input method — the inline rename editor now reports its caret position to the terminal, so the candidate window anchors next to the text you are typing.
