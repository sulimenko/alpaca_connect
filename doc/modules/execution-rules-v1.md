# Protected Alpaca execution/rules v1 (T-137/T-140)

`POST /api/execution/rules` uses the same service bearer and
`X-Service-Identity` as [T-133/T-135](trading-v2-execution.md). Authentication
precedes credential inspection and all native requests. The protected execution
hook also keeps rules bodies, headers and exceptions outside the public logger.
Rules bypasses the generic v2 handler; `orderId` is not required or reflected.

## Request and response

```json
{
  "version": 1,
  "account": "external-account-number-or-id",
  "live": false,
  "credentials": { "pkey": "call-local-key", "secret": "call-local-secret" },
  "instrument": {
    "symbol": "AAPL",
    "assetCategory": "STK",
    "exchange": "NASDAQ",
    "currency": "USD"
  }
}
```

`account` retains the protected service's request naming. A ready identity is
`{terminal:'ALPACA', externalAccount:account, live}`. Ready contains exactly
`version,state,identity,instrument,orders,quantity,price`. Only STK with native
`class='us_equity'` is covered. OPT and explicit non-USD requests are unsupported;
they cannot receive normalized stock/USD rules. Option execution is unchanged.

Authenticated schema/proof failures return only
`{version:1,state:'unavailable',reason:<fixed-code>}`. Unsupported domains use
`state:'unsupported'` with the same three-field shape. Reason codes are fixed
local categories, never broker messages or request values. Unauthorized and
non-POST responses retain the existing `{state:'unauthorized'}` / `invalid`
boundary. No response contains credentials, native extras or partial rules.

## Fresh native proof

The call uses only the existing request transport and fresh GETs, in this order:

1. `/v2/account` on the explicitly selected live or paper origin, with exact
   `account_number` or `id` equality. Status must be exactly `ACTIVE` and
   `account_blocked`, `trading_blocked`, `trade_suspended_by_user` must each be
   boolean false. The selected authenticated origin proves environment; no
   undocumented native `live` field or environment fallback is assumed.
2. `/v2/account/configurations`, requiring an object and `suspend_trade=false`.
   Supplied configuration permission fields must have their documented types.
   Missing optional fractional/short/overnight evidence closes those rows.
3. `/v2/assets/{symbol}`, requiring exact class/symbol/exchange, `status='active'`,
   `tradable=true`, and an explicit valid, duplicate-free attributes array.

Native transport/JSON failures stay sanitized. The rules-specific account helper
retains relevant native fields only within the current call; the v2 account
helper and worker attempt registry are unchanged. There is no SDK cache, Back
call, storage, order call or external integration.

Supported listed exchanges are the native AMEX, ARCA, BATS, NYSE, NASDAQ and
NYSEARCA domain. OTC and unknown exchanges are excluded. The documented
[asset attributes](https://docs.alpaca.markets/us/reference/get-v2-assets-1)
distinguish fractional extended eligibility, overnight eligibility/halt, IPO and
PTP restrictions. IPO and both PTP variants remain unsupported: this endpoint
does not prove a separate complete special-case matrix. Even a positive
`ptp_no_exception_entry` does not by itself prove all applicable PTP rules.
Unknown attributes fail closed rather than implying an unrestricted asset.

## Atomic capability matrix

Every `orders[]` row contains
`type,tif,sessions,relation,orderClass,quantityMode,side,positionEffect,quantity`.
Relation is `NORMAL`, class is `simple`, and quantity mode is `whole` or
`fractional`, matching the row's `quantity.fractional`. These common-wire values
describe quantity capability; native submission remains qty-based. No
bracket/OCO/OTO or notional order mode is advertised.

The [native equity order matrix](https://docs.alpaca.markets/us/docs/orders-at-alpaca)
is intersected with existing connector representation. Whole regular rows use
market/limit/stop/stop_limit with DAY/GTC, plus market/limit IOC/FOK. Ordinary
authenticated active listed-equity eligibility is the support proof under the
approved contract; no invented IOC/FOK account entitlement flag is introduced.
Every combination of `type,tif,relation,orderClass,quantityMode,side,positionEffect`
has exactly one row with its maximum proven native `sessions` scope. Whole limit
DAY/GTC includes extended sessions; market/stop/stop_limit and IOC/FOK remain
regular-only. Fractional rows use DAY only; fractional GTC, OPG and CLS are absent.
Price tick constraints also come from this native contract.

Buy-open and sell-close rows are independently available. Whole buy-close is
represented without assuming current position existence. Whole sell-open needs
`shorting_enabled=true`, `no_shorting=false`, native and configured margin
multiplier of 2 or 4, exact equity at least 2000 USD, `marginable=true`,
`shortable=true`, and `easy_to_borrow=true`.
[Margin and short-selling requirements](https://docs.alpaca.markets/us/docs/margin-and-short-selling)
do not grant a locate workflow: missing/false ETB proof closes opening short.
Other independently proven close rows can remain available. Fractional short
opening and fractional buy-to-cover are excluded; fractional sell is close-long.

Fractional eligibility requires both `fractional_trading=true` in configuration
and `fractionable=true` in the asset.
[Direct Trading fractional rules](https://docs.alpaca.markets/us/docs/fractional-trading)
prove DAY support, long-only sells and up to nine decimal places of qty precision.
The smallest positive representable qty and step are `0.000000001`; whole-share
rows use `1`. These are documented domain rules, not numeric fallbacks.

Rules v1 replaces only the old row-level `session` and `extended` fields with
`sessions[]`; all other row fields, envelopes, versions and capabilities remain
unchanged. Canonical arrays have no duplicates and use exactly one of:

- `['regular']`
- `['regular','pre_market','post_market']`
- `['regular','pre_market','post_market','overnight']`

An extended-capable combination has no additional regular-only row. Fresh active
account, nonblocking configuration and eligible listed asset, together with the direct Trading
contract, prove the combined regular/pre/post scope for whole limit DAY/GTC.
Fractional limit DAY receives that scope only with the `fractional_eh_enabled`
attribute; otherwise its scope is `['regular']`. Other fractional types remain
regular-only regardless of that attribute.
[Overnight proof](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api)
additionally requires `disable_overnight_trading=false`, `overnight_tradable` in
attributes and absence of `overnight_halted` from the explicit array. If newer
boolean overnight fields are present, they must agree with that proof.

Sessions describe one native execution scope, not a selection of independent
windows, separate orders or an execution guarantee. Submission still accepts
boolean `intent.extended`; extended limit DAY/GTC sends one native POST with
`extended_hours=true` and the original `time_in_force`. No local
clock/calendar inference, scheduler, session-bound cancel or re-submit is added.
An eligible order may carry across sessions under broker lifecycle semantics.
Rules does not prove current position size, buying power, market availability or
absence of competing orders; existing caller risk/lifecycle ownership remains.

## Exact constraints and summary

Each row's quantity is
`{fractional,minimum,step,maximum,minimumNotional}`. Finite numbers are plain
decimal strings; internal comparisons/grids/products use BigInt, with no
floating-point proof arithmetic. These equity proof endpoints do not document a
finite per-order qty maximum, so `maximum` is literal `'infinity'`. Undocumented
upper-bound metadata, buying power, positions, JavaScript safety limits and
parser length guards do not become broker maximum. A future finite cap requires
a documented applicable broker proof adapter; an arbitrary native extra is not
that proof. This exception applies only to maximum.

Under the approved
[minimum-order-value rule](https://docs.alpaca.markets/us/v1.1/docs/broker-api-faq),
every equity buy row has `{amount:'1',currency:'USD'}` minimumNotional; every sell
row has null, regardless of quantity or position effect. It is validation
metadata for qty orders and never converts submission into notional mode.

The top-level quantity is a summary. `fractional` indicates that some row is
fractional. Each other summary field retains a value only if all rows have the
same value; otherwise it is null. For a mixed whole/fractional buy/sell response:

```json
{
  "fractional": true,
  "minimum": null,
  "step": null,
  "maximum": "infinity",
  "minimumNotional": null
}
```

Null means no uniform rule, not unbounded or missing row proof. Concrete internal
`validateRule({rules,order,valuationPrice})` requires a unique row by the
nonsession capability keys and explicit `order.fractional`, then compares
canonical `order.sessions[]` with the row by content, including order and length.
Separate equal arrays are accepted; missing, empty, unknown, duplicate, reordered
or subset scopes and ambiguous rows are rejected. It then checks that row's qty
constraints, including consistency of `quantityMode` with `quantity.fractional`.
It never validates against the summary. Quantities/prices are
positive decimal strings; buy value validation needs explicit caller-supplied
valuationPrice and exact qty-times-price evidence. This internal helper does not
alter T-133/T-135 submit validation or guarantee a future fill price.

Price is `{rules:[...]}`. Each rule uses the common-wire fields
`minInclusive,maxExclusive,tick,precision,rounding`:

```json
{
  "rules": [
    { "minInclusive": "0", "maxExclusive": "1", "tick": "0.0001", "precision": 4, "rounding": "nearest_half_up" },
    { "minInclusive": "1", "maxExclusive": null, "tick": "0.01", "precision": 2, "rounding": "nearest_half_up" }
  ]
}
```

Bounds/ticks are decimal strings; `maxExclusive=null` means an unbounded price
interval. Quantity's unconfirmed maximum remains the literal `'infinity'`.
The intervals are `[0,1)` with tick `0.0001` / precision 4 and `[1,infinity)` with
tick `0.01` / precision 2. Exactly 1 uses the second interval. Required limit/stop
prices must lie on the exact zero-origin grid; zero is not an executable price.
Rounding names PBull client policy only. This connector never rounds or mutates
submitted values; PBull is unchanged.

## Validation and delivery

`node --test test/execution.js test/execution-http.js` covers T-137/T-140 scopes,
exact validation and extended DAY/GTC single-POST behavior plus T-133/T-135
regressions. The actual Impress HTTP suite exercises
rules authentication, v1 routing, fresh native proof, sanitization and native
failures using a controlled fetch fixture. Unexpected transport is blocked;
rules performs no real order. HTTP responses and runtime logs are checked for
credential/service-token sentinels.

On Node.js 24 run the focused test command above, `npm run lint`, `npm run types`
and `git diff --check`.
Independent worktree verification and commit/push/Draft PR delivery belong to
the pipeline; the implementation agent does not perform Git delivery.
