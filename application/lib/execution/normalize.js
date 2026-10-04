/* eslint-disable camelcase */
({ row, clientId }) => {
  // Exact decimal comparison prevents rounding a tiny fill to zero/full.
  // In particular, null/booleans/empty strings are never numeric evidence.
  const decimal = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) return null;
    const text = String(value);
    if (text.length > 64 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return { units: BigInt(whole + fraction), scale: fraction.length };
  };
  const compare = (left, right) => {
    const scale = Math.max(left.scale, right.scale);
    const a = left.units * 10n ** BigInt(scale - left.scale);
    const b = right.units * 10n ** BigInt(scale - right.scale);
    if (a === b) return 0;
    return a > b ? 1 : -1;
  };
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    typeof row.status !== 'string' ||
    row.client_order_id !== clientId ||
    typeof row.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.id)
  ) {
    return null;
  }
  const qty = decimal(row.qty);
  const filled = decimal(row.filled_qty);
  if (!qty || qty.units === 0n || !filled || compare(filled, qty) > 0) return null;
  const states = {
    new: 'pending',
    pending_new: 'pending',
    accepted: 'accepted',
    accepted_for_bidding: 'accepted',
    partially_filled: 'part_filled',
    filled: 'filled',
    pending_cancel: 'cancelling',
    pending_replace: 'pending',
    canceled: 'cancelled',
    expired: 'expired',
    rejected: 'rejected',
    done_for_day: 'pending',
    stopped: 'pending',
    suspended: 'pending',
    calculated: 'pending',
    held: 'pending',
    // We cannot prove a successor's lifecycle from the replaced row alone.
    replaced: null,
  };
  if (!Object.hasOwn(states, row.status)) return null;
  let state = states[row.status];
  if (
    !state ||
    (state === 'filled' && compare(filled, qty) !== 0) ||
    (state === 'part_filled' && (filled.units === 0n || compare(filled, qty) === 0))
  ) {
    return null;
  }
  if (filled.units > 0n) state = compare(filled, qty) === 0 ? 'filled' : 'part_filled';
  return { terminal_id: row.id, state };
};
