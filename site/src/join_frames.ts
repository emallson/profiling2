import { ScriptEntry } from "./saved_variables";

export type JoinDatum = {
  stats: Required<Pick<ScriptEntry["stats"], "samples">>;
  commits: ScriptEntry["commits"];
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
    const f = Math.random();
    let cum = 0;
    for (let i = 0; i < data.length; i++) {
      cum += weights[i];
      if (f <= cum) {
        return uniform_choice(data[i].stats.samples);
      }
    }
  }

  return result;
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
export default function join_data(data: JoinData, sample_count = 100): number[] {
  const weights = build_weights(data);

  const samples = [];
  for (let i = 0; i < sample_count * data.length; i++) {
    samples.push(sample_sum(data, weights));
  }

  return samples;
}

/**
 * Calculate the probability of *none* of the provided scripts activating in a given render.
 *
 * This is P[none activates] = ΠP[X_i does not activate] = Π(1 - P[X_i activates])
 */
export function zero_prob(data: JoinData, total_commits: number): number {
  return data.map((datum) => 1.0 - datum.commits / total_commits).reduce((a, b) => a * b, 1);
}
