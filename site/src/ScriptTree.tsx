import { useSelectedRecording } from "./EncounterSelector";
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import {
  IntermediateNode,
  Branches,
  TreeNode,
  buildScriptTree,
  isIntermediateNode,
  joined_samples,
  leaves,
} from "./frame_tree";
import { styled } from "@macaron-css/solid";
import { createVar, fallbackVar } from "@macaron-css/core";
import { assignInlineVars } from "@vanilla-extract/dynamic";
import * as Plot from "@observablehq/plot";
import * as format from "d3-format";

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
  let container!: HTMLDivElement;
  createEffect(() => {
    if (!props.branches) {
      return;
    }

    const branches = Object.entries(props.branches)
      .sort(([, nodeA], [, nodeB]) => weight(nodeB) - weight(nodeA))
      .slice(0, 10);

    const data = branches.flatMap(([key, node]) => {
      const samples = joined_samples(node);

      if (!samples) {
        return [];
      }

      return samples.map((sample) => ({
        value: sample,
        key,
      }));
    });

    const sampleCounts = Object.fromEntries(
      branches.map(([key, node]) => [key, joined_samples(node)?.length ?? 0])
    );

    const commits = Object.fromEntries(
      branches.map(([key, node]) => [
        key,
        leaves(node).reduce((sum, entry) => sum + entry.commits, 0),
      ])
    );

    const tickFormat = format.format("~s");

    const result = Plot.plot({
      y: {
        type: "symlog",
        ticks: [1, 10, 100, 1000, 10000, 100000, 1000000],
        tickFormat,
        label: "Est. Frame Count",
      },
      x: {
        domain: [0, 17],
        label: "Processing Time (ms)",
      },
      color: {
        type: "categorical",
        legend: true,
      },
      marks: [
        Plot.rectY(
          data,
          Plot.binX<{ fill: string }>(
            {
              y: {
                reduceIndex(index: number[], values: typeof data) {
                  const commitCount = commits[values[index[0]].key];
                  const sampleCount = sampleCounts[values[index[0]].key];
                  return (index.length / sampleCount) * commitCount;
                },
              },
            },
            { x: { value: "value", interval: 0.2 }, fill: "key" }
          )
        ),
      ],
    });

    container.replaceChildren(result);
  });

  return <div ref={container} />;
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
