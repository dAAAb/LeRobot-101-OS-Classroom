# Security and publication notes

- Bind to 127.0.0.1 only; no tunnel, remote robot discovery, telemetry or cloud inference.
- Serve only web/; reject hidden paths, traversal, symlinks escaping that root and unexpected Host headers.
- Optional simulation POST requires matching Origin, JSON, bounded finite angles and a small payload.
- No physical robot bridge: opening the demo cannot command a real motor.
- Webcam frames stay in browser memory. No recording/upload endpoint is implemented.
- Model downloads are HTTPS, fixed version, SHA-256 checked. Do not disable certificate checks.
- The example is a teaching service, not hardened multi-user infrastructure.

Before publication, inspect every tracked path and run scripts/audit_public.py. Scan Git history too; deleting a secret from the current tree does not remove earlier commits. Do not commit credentials, private IPs, home-directory paths, personal recordings, real device serial numbers or calibration data. If a credential is ever exposed, revoke it before cleaning history.

Report a security issue privately to the repository owner through GitHub's available security reporting controls; do not put live credentials in an issue.
