import { JoinData, join_data, uniform_choice } from "./join_frames";
import {
  ScriptEntry,
  SketchParams,
  SketchStats,
  TrackerData,
  bin_index_for,
  bin_index_to_left_edge,
  isNewTrackerData,
  isOldTrackerData,
} from "./saved_variables";

export type LeafNode = {
  // we may not have any data for an intermediate node
  self: TrackerData;
  parent?: TreeNode;
  key: string;
};

export type IntermediateNode = {
  children: Branches;
  parent?: TreeNode;
  key: string;
  joined_samples?: number[];
};

export type TreeNode = IntermediateNode | LeafNode;

export type Branches = Record<string, TreeNode>;
export type Roots = Branches;

export function isIntermediateNode(node: TreeNode): node is IntermediateNode {
  return "children" in node;
}

export function isDataNode(node: TreeNode): node is LeafNode {
  return "self" in node && node.self !== undefined;
}

function buildIntermediate(key: string, parent?: TreeNode): IntermediateNode;
function buildIntermediate(key: string, parent: TreeNode, self: ScriptEntry): LeafNode;
function buildIntermediate(key: string, parent?: TreeNode, self?: ScriptEntry): TreeNode {
  const child: LeafNode | Omit<IntermediateNode, "children"> = {
    parent,
    self,
    key,
  };

  if (!self) {
    (child as IntermediateNode).children = {};
  }

  if (parent) {
    (parent as IntermediateNode).children[key] = child as TreeNode;
  }
  return child as TreeNode;
}

/**
 * Punch through the tree to a target node, creating incomplete intermediate nodes as necessary to
 * reach the target.
 *
 * If another node already punched through this path, this may find and return an intermediate node.
 */
function punchMut(roots: Roots, script: ScriptEntry): TreeNode {
  const addonName = script.subject.addonName;
  if (!roots[addonName]) {
    roots[addonName] = buildIntermediate(addonName);
  }
  let intermediate: IntermediateNode = roots[addonName] as IntermediateNode;
  for (const key of script.subject.framePath) {
    intermediate =
      (intermediate.children[key] as IntermediateNode) ?? buildIntermediate(key, intermediate);
  }

  const frameName = script.subject.frameName;
  intermediate =
    (intermediate.children[frameName] as IntermediateNode) ??
    buildIntermediate(frameName, intermediate);

  // this script shouldn't already exist. if it does, we just bail
  if (intermediate.children[script.subject.scriptName]) {
    const err = new Error("duplicate leaf found");
    err.cause = {
      script,
      intermediate,
    };
    throw err;
  }

  return buildIntermediate(script.subject.scriptName, intermediate, script);
}

/**
 * Punch through the tree without modification, attempting to locate the appropriate leaf for the
 * provided `script`.
 */
export function punch(roots: Roots, script: ScriptEntry): TreeNode | undefined {
  const addonName = script.subject.addonName;
  if (!roots[addonName]) {
    return undefined;
  }
  let intermediate: IntermediateNode = roots[addonName] as IntermediateNode;
  for (const key of script.subject.framePath) {
    if (intermediate === undefined) {
      return undefined;
    }
    if ("children" in intermediate) {
      intermediate = intermediate.children[key] as IntermediateNode;
    } else {
      // somehow reached a leaf???
      return undefined;
    }
  }

  const frameName = script.subject.frameName;
  return (intermediate?.children[frameName] as IntermediateNode | undefined)?.children[
    script.subject.scriptName
  ];
}

export function buildScriptTree(
  scripts: ScriptEntry[],
  force_dependent: (key: ScriptEntry["subject"]) => boolean = () => false
): Roots {
  const roots: Roots = {};
  for (const entry of scripts) {
    if (entry.dependent === undefined && force_dependent?.(entry.subject)) {
      entry.dependent = true;
    }
    punchMut(roots, entry);
  }

  return roots;
}

export function virtualRoot(roots: Roots, name: string): TreeNode {
  return {
    key: name,
    children: roots,
  };
}

export function leaves(node: TreeNode): TrackerData[] {
  if (isDataNode(node)) {
    return [node.self];
  } else {
    return Object.values(node.children).flatMap(leaves);
  }
}

export type Bin = {
  left: number;
  right: number;
  height: number;
};

const sketchToBins = (sketch: SketchStats): Bin[] => {
  const bins = [sketch.trivial_count].concat(sketch.bins ?? []);

  for (const outlier of sketch.outliers) {
    const ix = bin_index_for(outlier);
    bins[ix] = (bins[ix] ?? 0) + 1 / sketch.count;
  }

  return bins
    .map((height, ix) => {
      const left = ix === 0 ? 0 : bin_index_to_left_edge(ix - 1);
      const right = bin_index_to_left_edge(ix);

      if (height === undefined) {
        return {
          left,
          right,
          height: 0,
        };
      }

      return {
        left,
        right,
        height: height <= 1 ? height : height / sketch.count,
      };
    })
    .reduce<Bin[]>((bins, bin) => {
      if (bins.length === 0) {
        bins.push(bin);
        return bins;
      }

      const prev = bins.at(-1)!;
      if (bin.left - prev.right < 0.1 && prev.right - prev.left < 0.45) {
        prev.right = bin.right;
        prev.height += bin.height;
      } else {
        bins.push(bin);
      }

      return bins;
    }, []);
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

const normalizedBinsFor = (sketch: SketchStats): number[] => {
  const bins = (sketch.bins ?? []).map((b) => b / sketch.count);

  for (const o of sketch.outliers) {
    const k = bin_index_for(o);
    bins[k] = (bins[k] ?? 0) + 1 / sketch.count;
  }

  for (let i = 0; i < bins.length; i++) {
    if (bins[i] === undefined) {
      bins[i] = 0;
    }
  }

  return bins;
};

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
  // moving the outliers into proper bins for ease of merging. outliers then no longer need to be
  // treated with particular rigour to maintain consistency and can simply do something that makes
  // visual sense
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
export function mergeSketchIndependent(sketches: SketchStats[], params: SketchParams): SketchStats {
  if (sketches.length === 0) {
    throw new Error("cannot perform an independent merge of an empty dataset");
  }

  return sketches.reduce((a, b) => mergeSketchPairIndependent(a, b, params));
}

export function joined_hists(node: TreeNode, params?: SketchParams): Bin[] | undefined {
  if (isDataNode(node) && isNewTrackerData(node.self)) {
    const bins = sketchToBins(node.self.sketch);
    return bins;
  } else if (isIntermediateNode(node)) {
    // we are ignoring `joined_samples` for now. perf problem to FIXME later
    const scripts = leaves(node).filter(isNewTrackerData);
    if (scripts.length === 1) {
      const bins = sketchToBins(scripts[0].sketch);
      return bins;
    } else if (scripts.length > 0) {
      const dependent = params ? scripts.filter((s) => s.dependent) : scripts;
      const independent = params ? scripts.filter((s) => !s.dependent) : [];

      const ind = params
        ? [
            mergeSketchIndependent(
              independent.map((s) => s.sketch),
              params
            ),
          ]
        : [];
      // TODO fix scale
      const bins = sketchToBins(mergeSketchDependent(dependent.map((s) => s.sketch).concat(ind)));
      return bins;
    }
  } else {
    return undefined;
  }
}

export function joined_samples(node: TreeNode): number[] | undefined {
  if (isDataNode(node) && isOldTrackerData(node.self)) {
    return node.self.stats.samples;
  } else if (isIntermediateNode(node)) {
    if (!node.joined_samples) {
      const scripts = leaves(node).filter(isOldTrackerData);
      if (scripts.some((script) => !script.stats.samples)) {
        return undefined; // don't attempt to do a partial join
      }

      if (scripts.length === 1) {
        // only one child, use its samples directly
        node.joined_samples = scripts[0].stats.samples;
      } else if (scripts.length > 0) {
        node.joined_samples = join_data(scripts as JoinData);
      }
    }
    return node.joined_samples;
  } else {
    return undefined;
  }
}
