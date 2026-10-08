/** Exact rational arithmetic. Non-terminating results use 36 decimal places, half up. */
export class Decimal {
  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}
  static from(value: string): Decimal {
    if (value.length > 1024 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
      throw new TypeError(`Invalid decimal amount: ${value.slice(0, 80)}`);
    }
    const [whole, fraction = ""] = value.split(".");
    return new Decimal(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
  }
  static zero(): Decimal {
    return new Decimal(0n, 1n);
  }
  add(other: Decimal): Decimal {
    return new Decimal(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    ).reduce();
  }
  subtract(other: Decimal): Decimal {
    return this.add(new Decimal(-other.numerator, other.denominator));
  }
  multiply(other: Decimal): Decimal {
    return new Decimal(this.numerator * other.numerator, this.denominator * other.denominator).reduce();
  }
  divide(other: Decimal): Decimal {
    if (other.numerator === 0n) throw new RangeError("Decimal division by zero");
    const sign = other.numerator < 0n ? -1n : 1n;
    return new Decimal(this.numerator * other.denominator * sign, this.denominator * other.numerator * sign).reduce();
  }
  compare(other: Decimal): number {
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  round(increment: Decimal, mode: "ceil" | "floor" | "half_up"): Decimal {
    if (increment.compare(Decimal.zero()) <= 0) throw new RangeError("Rounding increment must be positive");
    const units = this.divide(increment);
    let rounded = units.numerator / units.denominator;
    const remainder = units.numerator % units.denominator;
    if (mode === "ceil" && remainder > 0n) rounded++;
    if (mode === "floor" && remainder < 0n) rounded--;
    if (mode === "half_up" && (remainder < 0n ? -remainder : remainder) * 2n >= units.denominator)
      rounded += units.numerator < 0n ? -1n : 1n;
    return new Decimal(rounded, 1n).multiply(increment);
  }
  toString(): string {
    const scale = 10n ** 36n;
    const abs = this.numerator < 0n ? -this.numerator : this.numerator;
    const scaled = abs * scale;
    let integer = scaled / this.denominator;
    if ((scaled % this.denominator) * 2n >= this.denominator) integer++;
    if (integer === 0n) return "0";
    const digits = integer.toString().padStart(37, "0");
    const fraction = digits.slice(-36).replace(/0+$/, "");
    return `${this.numerator < 0n ? "-" : ""}${digits.slice(0, -36)}${fraction ? `.${fraction}` : ""}`;
  }
  private reduce(): Decimal {
    let a = this.numerator < 0n ? -this.numerator : this.numerator;
    let b = this.denominator;
    while (b !== 0n) [a, b] = [b, a % b];
    return a === 0n ? Decimal.zero() : new Decimal(this.numerator / a, this.denominator / a);
  }
}
export function nonnegativeDecimal(value: string): Decimal {
  const parsed = Decimal.from(value);
  if (parsed.compare(Decimal.zero()) < 0) throw new RangeError("Quantity and base rate must be nonnegative");
  return parsed;
}
export function sumDecimals(values: Iterable<string>): string {
  let total = Decimal.zero();
  for (const value of values) total = total.add(Decimal.from(value));
  return total.toString();
}
