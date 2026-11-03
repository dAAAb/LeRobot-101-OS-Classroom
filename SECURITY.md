# Security and privacy

- Default classroom server binds loopback only and serves the web root only.
- Camera frames stay in the browser. No microphone, telemetry, cloud inference or API keys.
- Pinned assets are fetched over verified HTTPS and checked against SHA-256.
- No arbitrary command execution, file upload endpoint, serial-port scanning or automatic device discovery.
- Robot control is optional and explicitly armed: Reachy through the local official daemon; SO-101 through a user-selected Web Serial port. Host/origin guards protect local HTTP writes. Serial writes are restricted to runtime position/speed and torque; no EEPROM writes.
- These are classroom prototypes, not certified safety controllers. Software stop cannot replace hardware emergency stop. Validate physical axes and limits with an unloaded, secured robot before live use.
- Do not publish camera recordings, calibration JSON, device identifiers, personal paths, credentials or private Git history.
- `scripts/audit_public.py` scans tracked content and committed blobs without printing matched secret values. This is a pattern audit, not a complete security proof.

Report a vulnerability privately to the repository owner. Do not paste working credentials or personal data into a public issue.
