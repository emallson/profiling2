import { ScriptEntry } from "./saved_variables";

export type JoinDatum = {
  stats: Required<Pick<ScriptEntry["stats"], "samples">>;
  commits: ScriptEntry["commits"];
  dependent?: ScriptEntry["dependent"];
};
export type JoinData = Array<JoinDatum>;

function build_weights(data: JoinData): number[] {
  const weights = [];
  let totalWeight = 0;
  for (const { commits } of data) {
    weights.push(commits);
    totalWeight += commits;
  }

  for (let i = 0; i < weights.length; i++) {
    weights[i] = weights[i] / totalWeight;
  }

  return weights;
}

function uniform_choice<T>(data: T[]): T {
  return data[Math.floor(Math.random() * data.length)];
}

function sample_sum(data: JoinData, weights: number[]): number {
  // 2n numbers is inefficient use of rng but its probably fine
  let result = 0;

  for (let i = 0; i < data.length; i++) {
    const f = Math.random();
    if (f <= weights[i]) {
      result += uniform_choice(data[i].stats.samples);
    }
  }

  // handle the case that we didn't sample anything. this truncates 0s
  if (result === 0) {
    return sample_any(
      data.map((datum) => datum.stats.samples),
      weights
    );
  }

  return result;
}

function sample_any(data: number[][], weights: number[]): number {
  const f = Math.random();
  let cum = 0;
  for (let i = 0; i < data.length; i++) {
    cum += weights[i];
    if (f <= cum) {
      return uniform_choice(data[i]);
    }
  }

  throw new Error(`sample_any failed to pick a sample: ${f} ${cum} ${data.length}`);
}

/**
 * This module contains an implementation of statistical merging / joining of frame data distributions
 * into a single über-distribution. It is explicitly not general purpose.
 *
 * We make a simplifying assumption that each OnEvent and OnUpdate script triggers independently of
 * all others. This is obviously not true---for example, you may have OnEvents that listen to the
 * same event that will always trigger together---but collecting precise co-trigger data (covariance?
 * research needed) is not currently done so simplifications are needed.
 *
 * Under this assumption, consider the following:
 *
 * The sample data for a frame script `S_i` comes from an underlying random variable `X_i` that
 * follows an unknown distribution.
 *
 * The distribution derived from simply concatenating all samples is then the distribution of the
 * process that selects a random `X_i` to sample from, then collects a sample---i.e. it is the "any
 * single script triggers" distribution.
 *
 * We want the "any combination of scripts may trigger" distribution, which is the weighted sum of
 * `X_i`s. Under the assumption above, let `w = [w_i]` be a vector of activation probabilities for `X
 * = [X_i]` random variables. Then we wish to compute `w.X`. We can do this in a simple Monte Carlo
 * fashion by choosing a random sample from each `S_i` with probability `w_i` and summing the result.
 *
 * In keeping with the underlying sampling distributions (which truncate 0 for display), we also
 * truncate zero by guaranteeing that at least one frame activates for our combined sample.
 */
export function join_data_sum(data: JoinData, sample_count = 10, min_samples = 100): number[] {
  const weights = build_weights(data);

  const samples = [];
  for (let i = 0; i < Math.max(sample_count * data.length, min_samples); i++) {
    samples.push(sample_sum(data, weights));
  }

  return samples;
}

/**
 * Analogue of `join_data_sum` that effectively unions the distributions instead of summing them.
 *
 * This is used in cases where independence is almost certainly the incorrect assumption.
 */
export function join_data_union(data: JoinData, sample_count = 10, min_samples = 100): number[] {
  const weights = build_weights(data);
  const data_samples = data.map((datum) => datum.stats.samples);

  return join_data_union_raw(data_samples, weights, sample_count, min_samples);
}

function join_data_union_raw(
  data: number[][],
  weights: number[],
  sample_count = 10,
  min_samples = 100
): number[] {
  const samples = [];
  for (let i = 0; i < Math.max(sample_count * data.length, min_samples); i++) {
    samples.push(sample_any(data, weights));
  }

  return samples;
}

/**
 * Join data, intelligently handling both independent (sum) and dependent (union) types.
 */
export function join_data(data: JoinData, sample_count = 10, min_samples = 100): number[] {
  if (data.length === 0) {
    throw new Error("cannot join empty data");
  }

  const independent = data.filter((datum) => !datum.dependent);
  const dependent = data.filter((datum) => datum.dependent);

  let indep_samples: number[] = [];
  let dep_samples: number[] = [];

  if (independent.length > 0) {
    indep_samples = join_data_sum(independent, sample_count, min_samples);
  }
  if (dependent.length > 0) {
    dep_samples = join_data_union(dependent, sample_count, min_samples);
  }

  if (independent.length === 0) {
    return dep_samples;
  } else if (dependent.length === 0) {
    return indep_samples;
  }

  const weights = [
    Math.max.apply(
      null,
      independent.map((v) => v.commits)
    ),
    Math.max.apply(
      null,
      dependent.map((v) => v.commits)
    ),
  ];

  return join_data_union_raw([indep_samples, dep_samples], weights, sample_count, min_samples);
}

/**
 * Calculate the probability of *none* of the provided scripts activating in a given render.
 *
 * This is P[none activates] = ΠP[X_i does not activate] = Π(1 - P[X_i activates])
 */
export function zero_prob(data: JoinData, total_commits: number): number {
  return data.map((datum) => 1.0 - datum.commits / total_commits).reduce((a, b) => a * b, 1);
}
