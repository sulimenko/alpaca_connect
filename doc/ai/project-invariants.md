## Project

Alpaca Connect — Metarhia/Impress integration service для Alpaca brokerage APIs.

## Layers

- `application/api/` — RPC contract, validation и thin orchestration.
- `application/domain/` — server-side state и lifecycle.
- `application/lib/` — Alpaca integrations и technical helpers.
- `application/config/` — runtime configuration.
- `application/db/` — infrastructure.
- `types/` — shared typing.

Не переносить ownership между API/domain/lib без explicit task scope.

## Alpaca integration

Основные зоны:

- `application/api/alpaca.2/**`
- `application/domain/clients/alpaca.js`
- `application/lib/alpaca/**`
- `application/config/alpaca.js`

External Alpaca response data считается integration input и должна безопасно обрабатываться.

## Auth

Auth runtime:

`application/api/auth.2/**`

Не менять auth/session semantics без explicit task scope.

## Safety

Без explicit approval запрещено:

- `.env`, secrets, tokens, credentials, private keys;
- dependencies/lockfiles;
- production configuration;
- auth/session semantic changes;
- unrelated refactor;
- generated logs/artifacts;
- destructive production action.
