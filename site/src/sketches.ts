import { TreeNode, isDataNode, isIntermediateNode, leaves } from "./frame_tree";
import { uniform_choice } from "./join_frames";
import {
  SketchParams,
  SketchStats,
  bin_index_for,
  bin_index_to_left_edge,
  defaultSketchParams,
  isNewTrackerData,
} from "./saved_variables";

export type Bin = {
  left: number;
  right: number;
  height: number;
};

const targetBinCount = 25;

export const sketchToBins = (
  sketch: SketchStats,
  params: SketchParams,
  domainEnd: number
): Bin[] => {
  const bins = [
    {
      left: 0,
      right: params.trivial_cutoff,
      height: sketch.trivial_count / sketch.count,
    },
  ];

  const binWidth = domainEnd / targetBinCount;

  const hist_bins = sketch.bins ?? [];

  for (let ix = 0; ix < hist_bins.length; ix++) {
    const h_left = bin_index_to_left_edge(ix, params);
    const h_right = bin_index_to_left_edge(ix + 1, params);

    const bin = bins[bins.length - 1];
    if (h_right - bin.left >= 1.25 * binWidth) {
      bins.push({
        left: h_left,
        right: h_right,
        height: hist_bins[ix] / sketch.count,
      });
    } else {
      bin.right = h_right;
      bin.height += hist_bins[ix] / sketch.count;
    }
  }

  const last_bin = bins.at(-1)!;
  if (last_bin.right - last_bin.left < binWidth) {
    last_bin.right = last_bin.left + binWidth;
  }

  return bins;
};
/**
 * Merge a set of dependent sketches.
 *
 * Dependent sketches may have runtimes that depend on other sketch's runtimes. Thus, we do cannot
 * safely make the independence assumption that results in the sum/prod behavior.
 */
export const mergeSketchDependent = (sketches: SketchStats[]): SketchStats => {
  const result: Required<SketchStats> = {
    count: 0,
    trivial_count: 0,
    bins: [],
    outliers: [],
  };

  for (const sketch of sketches) {
    result.count += sketch.count;
    result.trivial_count += sketch.trivial_count;
    result.outliers = result.outliers.concat(sketch.outliers);
    sketch.bins?.forEach((count, ix) => {
      result.bins![ix] = (result.bins?.[ix] ?? 0) + count;
    });
  }

  return result;
};

const and = (...terms: number[]) => terms.reduce((p, x) => p * x, 1);
const or = (...terms: number[]) => terms.reduce((p, x) => p + x, 0);

export const binsWithOutliers = (sketch: SketchStats, params: SketchParams): SketchStats => {
  const bins = sketch.bins?.slice(0) ?? [];

  for (const o of sketch.outliers) {
    const k = bin_index_for(o, params);
    bins[k] = (bins[k] ?? 0) + 1;
  }

  for (let i = 0; i < bins.length; i++) {
    if (bins[i] === undefined) {
      bins[i] = 0;
    }
  }

  return { ...sketch, bins };
};

const normalizedBinsFor = (sketch: SketchStats): number[] =>
  sketch.bins?.map((b) => b / sketch.count) ?? [];

const join_outliers = (sketch_a: SketchStats, sketch_b: SketchStats): number[] => {
  const result = [];

  // TODO do the math to verify this is representative
  const total = sketch_a.outliers.length + sketch_b.outliers.length;
  const p_a = sketch_a.outliers.length / total;
  const p_b = 1 - p_a;

  for (let i = 0; i < 10; i++) {
    let value = 0;
    if (Math.random() < p_a) {
      value += uniform_choice(sketch_a.outliers);

      if (Math.random() < p_b) {
        value += uniform_choice(sketch_b.outliers);
      }
    } else {
      value += uniform_choice(sketch_b.outliers);

      if (Math.random() < p_a) {
        value += uniform_choice(sketch_a.outliers);
      }
    }
    result.push(value);
  }

  return result;
};

export function mergeSketchPairIndependent(
  sketch_a: SketchStats,
  sketch_b: SketchStats,
  params: SketchParams
): SketchStats {
  // doing some setup
  const count = sketch_a.count + sketch_b.count;
  const bins_a = normalizedBinsFor(sketch_a);
  const bins_b = normalizedBinsFor(sketch_b);

  // construct the base measure
  const p_a_raw = sketch_a.count / count;
  const p_b_raw = sketch_b.count / count;

  // now the 4-element measure
  const p_none = (1 - p_a_raw) * (1 - p_b_raw);
  const p_both = p_a_raw * p_b_raw;
  const p_a_only = p_a_raw * (1 - p_b_raw);
  const p_b_only = (1 - p_a_raw) * p_b_raw;

  // probability of trivial or no activation
  const p_a_trivial = sketch_a.trivial_count / sketch_a.count;
  const p_b_trivial = sketch_b.trivial_count / sketch_b.count;
  const p_trivial_none = or(
    p_none,
    and(p_a_only, p_a_trivial),
    and(p_b_only, p_b_trivial),
    and(p_both, p_a_trivial, p_b_trivial)
  );

  const norm_bins: number[] = [];

  // bin weight from each activating independently
  for (const [p_unique, p_other_trivial, bins] of [
    [p_a_only, p_b_trivial, bins_a],
    [p_b_only, p_a_trivial, bins_b],
  ] as Array<[number, number, number[]]>) {
    for (let j = 0; j < bins.length; j++) {
      norm_bins[j] = or(
        norm_bins[j] ?? 0,
        and(or(p_unique, and(p_both, p_other_trivial)), bins[j])
      );
    }
  }

  // now the complicated case: both trigger at once. we pick one to be the "base" histogram and
  // shift bits of it according to the other histogram.
  //
  // it is critical that we be operating on normalized bins here, otherwise this is nonsensical and
  // results in incorrect weights
  const [base, other] = [bins_a, bins_b];
  for (let j = 0; j < other.length; j++) {
    for (let i = 0; i < base.length; i++) {
      const k = bin_index_for(
        bin_index_to_left_edge(j, params) + bin_index_to_left_edge(i, params),
        params
      );
      norm_bins[k] = or(norm_bins[k] ?? 0, and(p_both, base[i], other[j]));
    }
  }

  // now we denormalize everything and construct the result
  const scale = count / (1 - p_none);
  return {
    count: count,
    outliers: join_outliers(sketch_a, sketch_b),
    trivial_count: (p_trivial_none - p_none) * scale,
    bins: norm_bins.map((b) => (b !== undefined ? b * scale : 0)),
  };
}

/**
 * Okay, this method SUCKS. But.
 *
 * It works. It is the same as the old methods, but for histograms.
 *
 * In theory, at least. In practice it is much different.
 *
 * When working with a histogram, shifting by a constant means literally shifting bin indices. If
 * you want to add 0.5 to the samples represented by the histogram, you take every bin and
 * calculate k(j) = bin(invbin(j) + 0.5) for all of them and move every count to the
 * corresponding bin (summing as needed), with some arbitrary rule for splitting a bin that crosses
 * two bins k+ and k-.
 *
 * If you want to represent "with probability p, a is shifted by v" then you can do so by shifting
 * a proportion p of values in each bin a by v.
 *
 * This means that to calculate the histogram of a + b (that is: a and b as RVs, the literal sum of
 * them---as with two scripts running in the same frame) you convert b to a set of (p = weight, v)
 * pairs and shift a p-proportion of a by v.
 *
 * Note that care must be taken not to repeatedly shift by b. this means that you MUST create a new
 * c = a + b, not do inline modifications of c lest you shift by b, then by b + p(b)b_i (or
 * whatever the syntax is---this a docstring not a paper).
 *
 * The question then is: how do we initialize this?
 *
 * If you initialize it by the 0-histogram (aka the histogram with the bin corresponding to 0 equal
 * to 100%), then a + 0 = a. The 0 histogram is the ideal starting point, so rather than
 * constructing and starting from there, we can simply begin from a.
 *
 * The `SketchStats` datastructure has 3 "special bins": zero, near-zero, and outliers.
 *
 * Outliers are stored as raw samples and can be handled with the old sample-based methods.
 *
 * Zero and near-zero bins are just bins that are broken out due to the implementation details of
 * DDSketch (log(0) is -Infinity, so we can't store it in a regular bin. and near-zero we coalesce
 * into a single bin for efficiency rather than storing hundreds of bins for values that just mean
 * "fast enough that you don't care").
 *
 * For the purposes of merging histograms, the near-zero bin will shift by 0. This is obviously not
 * totally accurate, but since the values counted by this bin are frequently much closer to 0 than
 * to T, it is likely more accurate than the alternative (shifting by k(T))
 */
export function mergeSketchIndependent(
  sketches: SketchStats[],
  params: SketchParams,
  cutoff = 0
): SketchStats {
  if (sketches.length === 0) {
    throw new Error("cannot perform an independent merge of an empty dataset");
  }

  let filtered_sketches = sketches;
  if (sketches.length > 10 && cutoff > 0) {
    // discard scripts that don't have high outliers and that contribute less than a `cutoff`
    // fraction of the mass contributed by the top script.
    //
    // we use the top script as a reference point rather than sum because it avoids the cutoff
    // removing *all* data (lol) in cases where you have 1/cutoff equally-weighted scripts
    //
    // at the top of the tree, there can be hundreds of scripts, most of which have few-to-no
    // runs and will not meaningfully impact the visual result if omitted
    const max = Math.max.apply(
      null,
      sketches.map((b) => b.count)
    );
    filtered_sketches = sketches.filter(
      (sketch) => sketch.count / max > cutoff || (Math.max.apply(null, sketch.outliers) ?? 0) > 5
    );
  }

  return (
    filtered_sketches
      // moving the outliers into proper bins for ease of merging. outliers then no longer need to be
      // treated with particular rigour to maintain consistency and can simply do something that makes
      // visual sense
      .map((sketch) => binsWithOutliers(sketch, params))
      .reduce((a, b) => mergeSketchPairIndependent(a, b, params))
  );
}

export function joined_hists(
  node: TreeNode,
  params: SketchParams | undefined,
  domainEnd: number
): Bin[] | undefined {
  const sketchParams = params ?? defaultSketchParams;
  if (isDataNode(node) && isNewTrackerData(node.self)) {
    const bins = sketchToBins(
      binsWithOutliers(node.self.sketch, sketchParams),
      sketchParams,
      domainEnd
    );
    return bins;
  } else if (isIntermediateNode(node)) {
    const scripts = leaves(node).filter(isNewTrackerData);
    if (scripts.length === 1) {
      const bins = sketchToBins(
        binsWithOutliers(scripts[0].sketch, sketchParams),
        sketchParams,
        domainEnd
      );
      return bins;
    } else if (scripts.length > 0) {
      const dependent = params ? scripts.filter((s) => s.dependent) : scripts;
      const independent = params ? scripts.filter((s) => !s.dependent) : [];

      const ind =
        params && independent.length > 0
          ? [
              mergeSketchIndependent(
                independent.map((s) => s.sketch),
                params,
                0.025
              ),
            ]
          : [];
      const bins = sketchToBins(
        mergeSketchDependent(dependent.map((s) => s.sketch).concat(ind)),
        sketchParams,
        domainEnd
      );
      return bins;
    }
  } else {
    return undefined;
  }
}
