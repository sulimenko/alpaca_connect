({
  // Bounded parsing is a runtime safety guard, never a broker maximum.
  parse(value) {
    if (typeof value !== 'string' || value.length > 256 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
    const [whole, fraction = ''] = value.split('.');
    const integer = whole.replace(/^0+(?=\d)/, '');
    const tail = fraction.replace(/0+$/, '');
    const canonical = integer + (tail ? '.' + tail : '');
    return { canonical, units: BigInt(integer + tail), scale: tail.length };
  },
  compare(left, right) {
    const a = lib.execution.decimal.parse(left);
    const b = lib.execution.decimal.parse(right);
    if (!a || !b) return null;
    const scale = Math.max(a.scale, b.scale);
    const x = a.units * 10n ** BigInt(scale - a.scale);
    const y = b.units * 10n ** BigInt(scale - b.scale);
    if (x === y) return 0;
    return x > y ? 1 : -1;
  },
  onGrid(value, step) {
    const a = lib.execution.decimal.parse(value);
    const b = lib.execution.decimal.parse(step);
    if (!a || !b || b.units === 0n) return false;
    const scale = Math.max(a.scale, b.scale);
    return (a.units * 10n ** BigInt(scale - a.scale)) % (b.units * 10n ** BigInt(scale - b.scale)) === 0n;
  },
  productAtLeast(left, right, minimum) {
    const a = lib.execution.decimal.parse(left);
    const b = lib.execution.decimal.parse(right);
    const c = lib.execution.decimal.parse(minimum);
    if (!a || !b || !c) return false;
    const scale = Math.max(a.scale + b.scale, c.scale);
    return a.units * b.units * 10n ** BigInt(scale - a.scale - b.scale) >= c.units * 10n ** BigInt(scale - c.scale);
  },
});
