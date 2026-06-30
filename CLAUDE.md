# Project Instructions for Claude

This project implements a Code-as-Harness MVP.

## Core loop

Use Plan → Execute → Verify.

Never treat generated code as correct until it has been checked by executable verification.

## Safety

Default permission level is sandbox-edit.

Allowed without approval:
- read files
- list files
- grep/search
- edit files inside workspace/
- run pytest/ruff/mypy inside workspace/

Requires explicit approval:
- network calls
- package installation
- git push
- deleting files outside workspace/
- accessing credentials
- deployment
- modifying shell/profile/global config

Blocked:
- rm -rf /
- sudo
- chmod 777
- curl | sh
- printing environment secrets
- destructive git history edits

## Verification

Before claiming success, run:
- pytest
- ruff check . if available
- mypy . if available

If tools are missing, report that clearly.

## Output style

When done, report:
- files changed
- commands run
- verification result
- remaining risks
- next recommended step