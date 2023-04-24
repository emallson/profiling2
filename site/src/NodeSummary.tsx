import { styled } from "@macaron-css/solid";
import * as Plot from "@observablehq/plot";
import {
  IntermediateNode,
  LeafNode,
  TreeNode,
  buildScriptTree,
  isIntermediateNode,
  joined_samples,
  leaves,
} from "./frame_tree";
import { encounterName, useSelectedRecording } from "./EncounterSelector";
import { createMemo, createSignal, ErrorBoundary, For, Show } from "solid-js";
import { TrackerData, fromScriptEntry } from "./saved_variables";
import { style } from "@macaron-css/core";
import Chart from "./Chart";

const Title = styled("span", {
  base: {
    fontWeight: "bold",
    fontSize: "125%",
    fontFamily: "serif",
  },
});

function maxObservedTime(node: TreeNode): number {
  return Math.max.apply(
    null,
    leaves(node).flatMap((leaf) => leaf.top5)
  );
}

function topN(node: TreeNode, n = 10, cutoff = 1): number[] {
  return leaves(node)
    .flatMap((leaf) => leaf.top5)
    .sort((a, b) => a - b)
    .slice(-n)
    .filter((x) => x >= cutoff);
}

function totalCalls(node: TreeNode): number {
  return leaves(node)
    .map((leaf) => leaf.calls)
    .reduce((a, b) => a + b, 0);
}

/**
 * Calculate the least upper bound on the number of commits that were observed for this node.
 */
function leastCommits(node: TreeNode): number {
  return Math.max.apply(
    null,
    leaves(node).map((leaf) => leaf.commits)
  );
}

type VirtualRootNode = LeafNode & IntermediateNode;

const described = style({
  cursor: "help",
  textDecorationLine: "underline",
  textDecorationStyle: "dotted",
});

const ChildContainer = styled("div", {
  base: {
    display: "grid",
    rowGap: "0.25em",
    columnGap: "1em",
    gridTemplateColumns: "auto minmax(200px, auto)",
  },
});

export const INTERESTING_DURATION = 16.67;

const selectedChildStyle = style({
  backgroundColor: "#eee",
});

const dangerZoneMark = (max: number) =>
  Plot.barX(
    [
      {
        start: INTERESTING_DURATION,
        end: max,
        fill: "red",
        title: "More than 1 frame render at 60 FPS.",
      },
      {
        start: INTERESTING_DURATION / 10,
        end: INTERESTING_DURATION,
        fill: "yellow",
        title: "More than 10% of a frame render at 60 FPS.",
      },
    ],
    {
      x1: "start",
      x2: "end",
      fill: "fill",
      fillOpacity: 0.25,
      title: "title",
    }
  );

export function ChildSummary(props: {
  child: TreeNode;
  onClick: () => void;
  selected?: boolean;
  domainEnd?: number;
}) {
  const plot = createMemo<Plot.PlotOptions>(() => {
    const samples = joined_samples(props.child);
    const outliers = topN(props.child);

    const result: Plot.PlotOptions = {
      x: {
        zero: true,
        axis: null,
        domain: [0, props.domainEnd ?? INTERESTING_DURATION],
      },
      marginLeft: 10,
      marginRight: 10,
      marks: [
        dangerZoneMark(props.domainEnd ?? INTERESTING_DURATION),
        Plot.boxX(samples, { r: 0 }),
        Plot.dotX(outliers, {
          fill: "black",
          stroke: "black",
          strokeOpacity: 1,
          fillOpacity: 0.1,
          strokeWidth: 1,
        }),
      ],
    };

    return result;
  });
  return (
    <>
      <span class={props.selected ? selectedChildStyle : undefined} onClick={() => props.onClick()}>
        {props.child.key}
      </span>
      <Chart plot={plot()} />
    </>
  );
}

const NodeContainer = styled("div", {
  base: {
    maxWidth: 860,
  },
});

export function NodeSummary(props: { node: TreeNode; rootMode?: boolean }) {
  const [selectedChild, selectChild] = createSignal<TreeNode | undefined>();

  const children = createMemo(() => {
    selectChild(undefined);
    if (!isIntermediateNode(props.node)) {
      return undefined;
    }
    const children = Object.values(props.node.children);
    const top = Object.fromEntries(children.map((child) => [child.key, topN(child, 1, 0)[0]]));
    return children.sort((a, b) => top[b.key] - top[a.key]);
  });

  const domainEnd = createMemo(() => {
    return Math.max(INTERESTING_DURATION, topN(props.node, 1, 0)[0] + 1);
  });

  const histogram = createMemo<Plot.PlotOptions | undefined>(() => {
    const samples = joined_samples(props.node) ?? [];

    return {
      x: {
        domain: [0, domainEnd()],
        ticks: [0.25 * domainEnd(), 0.5 * domainEnd(), 0.75 * domainEnd(), domainEnd()],
        tickFormat: (t) => `${(1000 / t).toFixed(1)}`,
        label: "Maximum Possible FPS",
      },
      y: {
        axis: null,
      },
      marks: [
        dangerZoneMark(domainEnd()),
        Plot.rectY(
          samples,
          Plot.binX<{ fill: string }>(
            { y: "proportion" },
            {
              x: { value: (d) => d, interval: props.rootMode ? undefined : 0.5 },
              fill: "black",
            }
          )
        ),
      ],
      marginLeft: 10,
      marginRight: 10,
      // width: 200,
    };
  });

  return (
    <>
      <NodeContainer>
        <section>
          <header>
            <Title>{props.node.key}</Title>
          </header>
          <ChildContainer>
            <dl>
              <dt>Max Obs. Time</dt>
              <dd>{maxObservedTime(props.node).toFixed(3)}</dd>
              <dt>Script Calls</dt>
              <dd>{totalCalls(props.node)}</dd>
              <dt
                class={described}
                title="The number of frame renders in which this node was called at least once."
              >
                Render Activations
              </dt>
              <dd>
                {!isIntermediateNode(props.node) || props.rootMode ? "" : "≥"}
                {leastCommits(props.node)}
              </dd>
            </dl>
            <Show when={histogram()} fallback={<div />}>
              {(plot) => <Chart plot={plot()} />}
            </Show>
            <For each={children()}>
              {(child) => (
                <ChildSummary
                  selected={child === selectedChild()}
                  child={child}
                  domainEnd={domainEnd()}
                  onClick={() => selectChild(child)}
                />
              )}
            </For>
          </ChildContainer>
        </section>
      </NodeContainer>
      <Show when={selectedChild()}>{(child) => <NodeSummary node={child()} />}</Show>
    </>
  );
}

const RootContainer = styled("div", {
  base: {
    display: "grid",
    gridAutoColumns: "max-content",
    gridAutoFlow: "column",
    gap: "2em",
  },
});

// onUpdate's elapsed field is seconds, not ms
const OUD_SCALE = 1000;
function scaledUpdateDelay(data: TrackerData): TrackerData {
  return {
    top5: data.top5.map((x) => x * OUD_SCALE),
    total_time: data.total_time * OUD_SCALE,
    stats: {
      mean: data.stats.mean * OUD_SCALE,
      variance: data.stats.variance ? data.stats.variance * Math.pow(OUD_SCALE, 2) : undefined,
      // not even trying
      skew: undefined,
      samples: data.stats.samples?.map((sample) => sample * OUD_SCALE),
      quantiles: data.stats.quantiles
        ? Object.fromEntries(
            Object.entries(data.stats.quantiles).map(([k, v]) => [k, v * OUD_SCALE])
          )
        : undefined,
    },
    calls: data.calls,
    commits: data.commits,
  };
}

function DisplayError(props: { err: unknown }) {
  return (
    <Show
      when={props.err instanceof Error}
      fallback={<div>{(props.err as object).toString()}</div>}
    >
      <div>An error has occurred.</div>
      <div>{(props.err as Error).toString()}</div>
      <pre>{(props.err as Error).stack}</pre>
    </Show>
  );
}

export function RootSummary() {
  const recording = useSelectedRecording();
  const overall = createMemo<VirtualRootNode | undefined>(() => {
    const rec = recording();
    if (!rec || !rec.data.onUpdateDelay) {
      return undefined;
    }

    const scripts = Array.from((rec.data.scripts as Map<string, TrackerData>).entries());
    const roots = buildScriptTree(scripts.map(fromScriptEntry));

    return {
      key: encounterName(rec.encounter),
      self: scaledUpdateDelay(rec.data.onUpdateDelay),
      children: roots,
    };
  });

  return (
    <ErrorBoundary fallback={(err) => <DisplayError err={err} />}>
      <RootContainer>
        <Show when={overall()}>{(overall) => <NodeSummary node={overall()} rootMode />}</Show>
      </RootContainer>
    </ErrorBoundary>
  );
}
