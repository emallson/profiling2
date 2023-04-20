import join_data, { JoinData } from "./join_frames";
import { ScriptEntry } from "./saved_variables";

export type LeafNode = {
  // we may not have any data for an intermediate node
  self: ScriptEntry;
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

export function buildScriptTree(scripts: ScriptEntry[]): Roots {
  const roots: Roots = {};
  for (const entry of scripts) {
    punchMut(roots, entry);
  }

  return roots;
}

function leaves(node: TreeNode): ScriptEntry[] {
  if (isIntermediateNode(node)) {
    return Object.values(node.children).flatMap(leaves);
  } else {
    return [node.self];
  }
}

export function joined_samples(node: TreeNode): number[] | undefined {
  if (isIntermediateNode(node)) {
    if (!node.joined_samples) {
      const scripts = leaves(node);
      if (scripts.some((script) => !script.stats.samples)) {
        return undefined; // don't attempt to do a partial join
      }
      node.joined_samples = join_data(scripts as JoinData);
    }
    return node.joined_samples;
  } else {
    return node.self.stats.samples;
  }
}
