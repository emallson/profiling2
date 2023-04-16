import gamma from "gamma";

const beta = (mu: number, v: number) => {
  const a = alpha(mu, v);
  return a / mu - a;
};
const alpha = (mu: number, v: number) =>
  -Math.pow(mu, 3) / v + Math.pow(mu, 2) / v - mu;

const est_skew = (alpha: number, beta: number) =>
  (2 * (beta - alpha) * Math.sqrt(alpha + beta + 1)) /
  ((alpha + beta + 2) * Math.sqrt(alpha * beta));

const pct_err = (actual: number, estimated: number) =>
  Math.abs(actual - estimated) / actual;

export type BetaParams = {
  alpha: number;
  beta: number;
  max: number;
};

export const skew_err = ({ alpha, beta }: BetaParams, sample_skew: number) => {
  const exp_skew = est_skew(alpha, beta);
  return {
    abs: Math.abs(sample_skew - exp_skew),
    pct: pct_err(sample_skew, exp_skew),
  };
};

export const pdf = ({ alpha: a, beta: b, max }: BetaParams, x: number) => {
  const sx = x / max;
  return (
    (Math.pow(sx, a - 1) * Math.pow(1 - sx, b - 1) * gamma(a + b)) /
    (gamma(a) * gamma(b))
  );
};

/**
 * Fit the Beta distribution from the mean (`mu`), variance (`v`) and `max`.
 *
 * `max` defaults to 1 if unsupplied.
 * `min` is assumed to be 0.
 */
export const fit = (mu: number, v: number, max = 1) => {
  const sMu = mu / max;
  const sV = v / Math.pow(max, 2);
  const a = alpha(sMu, sV);
  const b = beta(sMu, sV);

  return {
    alpha: a,
    beta: b,
    max,
  };
};
