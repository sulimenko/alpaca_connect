# Alpaca Connect — AI Pipeline v8.2 project settings

Repository: `sulimenko/alpaca_connect`.

Short name: `alpaca_connect`.

## Git

Base: `develop`.

Queue: `ai-task-queue`.

## Runtime

Required Node.js: `24`.

Engine: `>=24 <25`.

Local bootstrap:

`~/.ai-pipeline/projects/<repo-key>/env.sh`

## Shared policy

Canonical local pipeline:

`~/.ai-pipeline/`

ChatGPT-readable snapshot:

`ai-task-queue:doc/pipeline/v8.2.0/`

## Validation

Default:

    npm test

Targeted:

    npm run lint
    npm run types

Project wrapper:

    BASE_BRANCH=develop CHECK_MODE=default bash doc/ai/project-checks.sh

## Constraints

Preserve API/domain/lib ownership.

Without explicit approval:

- no `.env`;
- no secrets/tokens;
- no dependencies or lockfile changes;
- no auth/session semantic changes;
- no unrelated refactor.
