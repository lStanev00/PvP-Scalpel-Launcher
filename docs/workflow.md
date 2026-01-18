# Launcher Workflow

This document describes the runtime workflow and the log order you should see
in the launcher.

## Steps

1) Get paths
   - Detect WoW install path (addon root).
   - Detect desktop app install path.

2) Detect local versions
   - Read desktop app version from registry.
   - Read addon version from the `.toc` file.

3) Fetch manifest
   - Fetch the manifest from the API (cached in RAM after the first call).

4) Compare versions
   - Compare local desktop version vs manifest target.
   - Compare local addon version vs manifest target.

5) Outcome
   - If both match, status is OK and launch can unlock.
   - If any mismatch or error occurs, status is locked and update is required.

## Expected log flow

- Launcher initialized
- WoW path detected / not found
- Desktop path detected / not found
- Desktop version detected
- Addon version detected
- Manifest fetched
- Desktop version OK / mismatch
- Addon version OK / mismatch
