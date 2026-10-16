Shapes written by the engine layer's `engine-lane` (its lane.py `_save_registry` and `_log`), with made-up values.

- `session-file.json`: `<sessions dir>/<pid>.json`. It has no tmux pane: the lane is found by its process being inside a pane. `sessionId` is the lane's own id until the engine names a session, then the engine's, and the lane's again after `/clear`.
- `transcript.jsonl`: one line per record. `user` is written when the lane takes a message, with a timestamp in whole seconds (`%Y-%m-%dT%H:%M:%SZ`).
