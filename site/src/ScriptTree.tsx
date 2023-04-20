import { useSelectedRecording } from "./EncounterSelector";
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  IntermediateNode,
  Branches,
  TreeNode,
  buildScriptTree,
  isIntermediateNode,
  joined_samples,
} from "./frame_tree";
import { styled } from "@macaron-css/solid";
import { createVar, fallbackVar } from "@macaron-css/core";
import { assignInlineVars } from "@vanilla-extract/dynamic";

function weight(node: TreeNode): number {
  const samples = joined_samples(node);
  if (!samples) {
    return 0;
  }

  samples.sort();

  const index = (samples.length - 1) * 0.95;
  if (Number.isInteger(index)) {
    return samples[index];
  } else {
    return (samples[Math.floor(index)] + samples[Math.ceil(index)]) / 2;
  }
}

const NodeLabel = styled("div", {
  base: {
    backgroundColor: "#eee",
    overflowX: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    ":hover": {
      backgroundColor: "#ddd",
    },
  },
});

function DisplayNode(props: { node: TreeNode; onClick: () => void }) {
  const content = createMemo(() => `${props.node.key} (${weight(props.node).toFixed(3)})`);
  return (
    <NodeLabel onClick={props.onClick} title={content()}>
      {content()}
    </NodeLabel>
  );
}

const widthVar = createVar("width");

const NodeContainer = styled("div", {
  base: {
    minWidth: `calc(${fallbackVar(widthVar, "1%")} - 2px)`,
    maxWidth: `calc(${fallbackVar(widthVar, "1%")} - 2px)`,
    ":first-child": {
      minWidth: fallbackVar(widthVar, "1%"),
      maxWidth: fallbackVar(widthVar, "1%"),
    },
  },
});

const BranchesContainer = styled("div", {
  base: {
    display: "flex",
    flexWrap: "nowrap",
    flexDirection: "row",
    gap: "2px",
  },
});

const RootContainer = styled("div", {
  base: {
    maxWidth: "80vw",
  },
});

function DisplayBranches(props: {
  branches: Branches | undefined;
  parentWeight?: number;
  selectNode: (node: TreeNode) => void;
}) {
  const totalWeight = createMemo(() => {
    if (!props.branches) {
      return undefined;
    }

    // due to rng we could end up with a sum of children having greater weight than the parent.
    // deal with that case.
    const branchWeight = Object.values(props.branches).reduce((a, b) => a + weight(b), 0);

    if (props.parentWeight && branchWeight > props.parentWeight) {
      return branchWeight;
    } else {
      return props.parentWeight ?? branchWeight;
    }
  });

  const sortedBranches = createMemo(
    () => props.branches && Object.values(props.branches).sort((a, b) => weight(b) - weight(a))
  );
  return (
    <BranchesContainer>
      <Show when={sortedBranches()}>
        <For each={sortedBranches()}>
          {(node) => (
            <NodeContainer
              style={assignInlineVars({
                [widthVar]:
                  (
                    (Math.min(weight(node), totalWeight() ?? weight(node)) / (totalWeight() ?? 1)) *
                    100
                  ).toFixed(2) + "%",
              })}
            >
              <DisplayNode node={node} onClick={() => props.selectNode(node)} />
              <Show when={isIntermediateNode(node) && weight(node) > 0.02}>
                <DisplayBranches
                  selectNode={props.selectNode}
                  branches={(node as IntermediateNode).children}
                  parentWeight={weight(node)}
                />
              </Show>
            </NodeContainer>
          )}
        </For>
      </Show>
    </BranchesContainer>
  );
}

export default function ScriptTree() {
  const recording = useSelectedRecording();

  const roots = createMemo(() => {
    const scripts = recording()?.data.scripts;
    if (!scripts) {
      return undefined;
    }

    return buildScriptTree(scripts);
  });

  const [node, setNode] = createSignal<TreeNode | undefined>(undefined);

  return (
    <div>
      <Show
        when={node()}
        fallback={
          <RootContainer>
            <DisplayBranches branches={roots()} selectNode={setNode} />
          </RootContainer>
        }
      >
        <button onClick={() => setNode(undefined)}>Reset</button>
        <RootContainer>
          <DisplayBranches branches={{ "": node()! }} selectNode={setNode} />
        </RootContainer>
      </Show>
    </div>
  );
}
