import { JoinData, join_data } from "./join_frames";
import {
  ScriptEntry,
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
export function mergeSketchIndependent(sketches: SketchStats[]): SketchStats {
  if (sketches.length === 0) {
    throw new Error("cannot perform an independent merge of an empty dataset");
  }

  const total_weight = sketches.reduce((total, sketch) => total + sketch.count, 0);
  const total_trivial = sketches.reduce((total, sketch) => total + sketch.trivial_count, 0);
  const result_bins: number[] = [];

  const add_bin = (ix: number, w: number) => {
    // don't extend the array for 0s
    if (ix > result_bins.length && w === 0) {
      return;
    }
    result_bins[ix] = (result_bins[ix] ?? 0) + w;
  };
  const shift_bin = (from_ix: number, to_ix: number, v: number) => {
    add_bin(from_ix, -v);
    add_bin(to_ix, v);
  };

  for (const sketch of sketches) {
    // relative probability of this sketch triggering
    const p_activate = sketch.count / total_weight;

    if (sketch.bins === undefined || sketch.bins === null) {
      // if we have no bins, we just aren't shifting it. outliers are handled separately
      continue;
    }

    // first, we handle the non-unique activation case. this is shifting existing data based on the
    // probability of this activating *and* running for the amount of time in bin j
    //
    // the first sketch considered won't have anything to shift, so this does nothing and only the
    // unique activation (see below) is really run

    // we work with a copy of the previous data because it is difficult for me to reason through
    // in-place shifting right now.
    const tmp = result_bins.slice(0);
    for (let j = 0; j < sketch.bins.length; j++) {
      const pct = (p_activate * sketch.bins[j]) / sketch.count;
      for (let i = 0; i < tmp.length; i++) {
        const k = bin_index_for(bin_index_to_left_edge(j) + bin_index_to_left_edge(i));
        shift_bin(i, k, pct * (tmp[i] ?? 0));
      }
    }

    // NOTE: must be careful to normalize all bin values by sketch.count other the combined weights
    // get fucked
    for (let j = 0; j < sketch.bins.length; j++) {
      add_bin(j, (sketch.bins[j] / sketch.count) * p_activate);
    }
  }

  for (let i = 0; i < result_bins.length; i++) {
    if (result_bins[i] === undefined) {
      result_bins[i] = 0;
    }
  }

  return {
    count: total_weight,
    trivial_count: total_trivial / total_weight,
    bins: result_bins,
    outliers: sketches.reduce<number[]>((a, b) => a.concat(b.outliers), []),
  };
}

export function joined_hists(node: TreeNode): Bin[] | undefined {
  if (isDataNode(node) && isNewTrackerData(node.self)) {
    const bins = sketchToBins(node.self.sketch);
    console.log("data node", bins);
    return bins;
  } else if (isIntermediateNode(node)) {
    // we are ignoring `joined_samples` for now. perf problem to FIXME later
    const scripts = leaves(node).filter(isNewTrackerData);
    if (scripts.length === 1) {
      const bins = sketchToBins(scripts[0].sketch);
      console.log("single child", bins);
      return bins;
    } else if (scripts.length > 0) {
      const dependent = scripts.filter((s) => s.dependent);
      const independent = scripts.filter((s) => !s.dependent);

      const ind = mergeSketchIndependent(independent.map((s) => s.sketch));
      // TODO fix scale
      const bins = sketchToBins(mergeSketchDependent(dependent.map((s) => s.sketch).concat([ind])));
      console.log("merge", node, bins);
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
