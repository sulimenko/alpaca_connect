# Protected Alpaca Trading v2 execution (T-133)

Metaterminal owns lifecycle, risk, fencing, reservations, durable operation identity
and the permanent placement barrier. This connector owns native authenticated
Alpaca transport and recovery. Back is outside the submit/lookup/marketdata hot
path. Credentials remain call-local: no SDK credential cache, durable receipt or
credential storage is introduced.

## Service boundary and versions

The first protected API is `application/api/execution.1.js`. Legacy public
`alpaca.2` endpoints and auth/session semantics are unchanged. Package and lockfile
version are `26.10.0`; API version stays `1`, wire version stays `2`.

Only POST requests to `/api/execution/submit`, `/api/execution/lookup`,
`/api/execution/marketdata`, `/api/execution/capabilities` are supported. All require
an exact `Authorization: Bearer <BROKER_EXECUTION_TOKEN>` (dedicated service token,
at least 32 characters) and `X-Service-Identity: metaterminal-execution`. Missing,
wrong or user-session bearers and wrong service identity are rejected before
broker touch. The execution hook bypasses the legacy request-body/header logger.
The token is configured outside Git. HTTPS termination and disabling sensitive
body/header capture in reverse proxies and APM are required deployment settings.

Capabilities are exactly:

```json
{
  "version": 2,
  "terminal": "ALPACA",
  "contract": "meta-alpaca-v2-2",
  "submit": true,
  "recovery": "client_order_id",
  "restart_safe": true,
  "marketdata": true
}
```

`restart_safe` means native recovery is independent of connector RAM **when Meta
retains and enforces its durable placement barrier**. It does not promise that
repeating submit after connector restart is safe.

## Fresh account proof and submit

Requests carry `version: 2`, canonical scalar `account`, boolean `live`, and
`credentials: { pkey, secret }`. Submit/lookup require a positive safe integer
`orderId`; lookup optionally pins a validated scalar `brokerId`.

Every authoritative submit, lookup and marketdata outcome uses fresh native
`GET /v2/account` with the credentials supplied by that call. Canonical account
must exactly equal a returned stable `account_number` or `id`. Live uses
`https://api.alpaca.markets`; paper uses `https://paper-api.alpaca.markets`. There is
no fuzzy matching, environment fallback or credential cache. Failed account
proof returns `source_unavailable`, with no order/data request.

Submit accepts Meta's normalized STK/OPT intent: `symbol`, signed nonzero finite
`quantity`, `type` (market/limit/stop/stop_limit), `tif` (day/gtc/ioc/fok), boolean
`extended`, positive finite required `limitPrice`/`stopPrice`, `relation: NORMAL`
and empty `related`. Extended hours require limit/day. Unsupported groups
(BRK/OCO) are rejected before placement. The signed quantity determines buy/sell;
broker qty is its absolute value. Broker-level eligibility remains Alpaca's
responsibility.

Correlation is deterministic `client_order_id=meta-<orderId>`. Each worker claims
an orderId synchronously before account proof/POST, retaining only canonical
account/environment, normalized intent hash and sanitized outcome/identity.
Parallel requests cannot both own a POST. Changed account/environment or intent
conflicts fail closed. The bounded registry never evicts attempts to grant another
POST; exhaustion returns ambiguous. It is a worker-local concurrency guard only.

Repeat submit still validates the current supplied account credentials, even when
returning a cached result or rejecting a conflict/invalid intent. An invalid
request envelope cannot produce account proof. If an orderId already has a worker
attempt, invalid intent/envelope/credentials, revoked credentials, failed account
proof or transport failure returns ambiguous/source_unavailable and never
replaces the prior attempt outcome or sends another order POST. A valid repeat
may return the latest sanitized outcome only after fresh proof. Successful lookup
replaces an older cached rejection with recovered broker evidence: acknowledged
for active/exposure states, ambiguous for a recovered zero-fill terminal row.
A POST response arriving after that lookup cannot overwrite the recovered worker
evidence or reopen placement.

Only a structured native 400/401/403/422 rejection with valid error code/message
and no order/duplicate evidence, or a normalized terminal zero-fill order, proves
an initial rejection. Duplicate-ID, timeout, network, malformed JSON, 5xx or
contradictory evidence stays ambiguous. Raw upstream bodies/messages/exceptions
never cross the service boundary. Error responses echo only validated numeric
orderId (otherwise null), never raw request objects.

## Restart recovery and permanent no-resubmit ownership

Meta must durably commit its attempted-placement barrier **before** calling
submit. Once placement is possible, Meta must only reconcile/lookup that durable
operation identity and must never call submit again, including after connector,
worker or Meta restart. Recovery is native
`GET /v2/orders:by_client_order_id?client_order_id=meta-<orderId>`, independent of a
connector RAM receipt. A supplied brokerId and any remembered brokerId must match
exactly; there is no symbol/quantity/time matching. Successful recovery also
blocks a subsequent submit in that worker.

`client_order_id` is a recovery identity, not an assumed permanent broker-side
idempotency lock. A broker may accept the same ID after a prior order is complete.
After a full connector restart, calling submit again could therefore place a
second order. Only Meta's durable barrier prevents this; connector RAM and broker
duplicate rejection do not. Tests model this reuse explicitly.

A proven initial native 404 after account proof can return `not_found`. Absence
is never permission to retry or to release exposure after Meta's durable attempted
barrier. A worker that already knows a possible placement, or a lookup with a
brokerId pin, returns source_unavailable for contradictory absence. After restart
Meta must preserve its own attempted-placement context and reconciliation policy.

## Strict order evidence

Both `qty` and `filled_qty` must be finite, nonnegative decimal scalars; qty must
be positive and fill cannot exceed qty. Decimal strings are compared exactly,
without rounding through floating-point coercion. Missing, null, boolean, empty,
malformed, negative, overlong or inconsistent evidence fails closed. A partially
filled status requires strictly partial fill; a filled status requires full fill.

| Native state                               | Zero fill policy                                    |
| ------------------------------------------ | --------------------------------------------------- |
| new, pending_new                           | pending                                             |
| accepted, accepted_for_bidding             | accepted                                            |
| pending_cancel                             | cancelling                                          |
| pending_replace, done_for_day              | pending                                             |
| stopped, suspended, held                   | pending; never terminal no exposure                 |
| calculated                                 | pending; positive valid fill determines exposure    |
| canceled, expired, rejected                | cancelled / expired / rejected only with valid zero |
| partially_filled, filled                   | invalid; require corresponding positive evidence    |
| replaced (including a successor reference) | unavailable; successor lifecycle is not proven      |
| unknown or malformed                       | unavailable                                         |

Except for fail-closed/contradictory states, valid positive filled_qty produces
`part_filled` or `filled` when qty proves full execution. In particular a
cancelled/expired/rejected row with fills never becomes a no-exposure terminal
outcome. Lookup returns `found` only for a normalized order; otherwise unavailable.
Submit returns acknowledged for exposure states and rejected only for a proven
zero-fill terminal state. See the native
[Alpaca order lifecycle](https://docs.alpaca.markets/docs/orders-at-alpaca) and
[lookup by client order ID](https://docs.alpaca.markets/reference/getorderbyclientorderid).

## Protected IEX market data

Current Meta callers send `kind: bars` with `symbol`, `start`/`end` and `limit`
(1..10000), or `kind: snapshots` with up to 100 symbols. Every call first proves the
selected trading account, then requests native stock data with `feed=iex`. Bars
use `timeframe=1Hour` and return numeric close/high/low/open/timestamp/turnover/
volume. Pagination validates bounds/tokens, rejects cycles and empty advancing
pages. Snapshots return symbol and formatted price/prevClose/change/changeP.
Missing/malformed/non-finite numeric data or calculations fail closed. Only the
sanitized Meta fields are returned; upstream extras are discarded.

## Validation and rollout gate

Run `node --test test/execution.js test/execution-http.js`, `npm run lint`,
`npm run types`, and the safe project checks. The focused suite includes strict
fill/status matrices, repeat-submit failures after acknowledgment/lost response,
concurrency, account/environment proof, broker pins, duplicate evidence,
pagination, sanitization, and Meta's durable barrier against reusable broker IDs.

The real Impress test preloads a controlled fetch fixture in actual workers,
blocks unexpected transport and exercises authorized broker success, native
rejection, malformed upstream data, transport/JSON failure, auth failures and
lost-response recovery after complete process restart. It scans HTTP responses,
stdout/stderr and Impress file logs for key/secret/service-token sentinels,
including malformed request/orderId objects. No real broker orders are sent.

Cross-repository Meta rollout remains **closed** until separate verification
proves exact `meta-alpaca-v2-2` plus `restart_safe: true` capability enforcement and
the durable pre-transport placement barrier across restarts. The local v2-1 Meta
candidate is insufficient. Deployment must preserve Meta's permanent barrier;
this change does not edit Meta or Back. Independent pipeline verification of the
actual worktree must pass before pipeline-owned commit/push/Draft PR delivery.
