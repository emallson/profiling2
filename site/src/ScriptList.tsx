import { For, Show, createMemo } from "solid-js";
import { useSelectedRecording } from "./EncounterSelector";
import { ScriptEntry } from "./saved_variables";
import * as Plot from "@observablehq/plot";
import { fit, pdf, skew_err } from "./beta";
import { styled } from "@macaron-css/solid";

const pdfPoints: number[] = [];

const jitter = 0.01;
const width = 0.05;

for (let i = 0; i <= 1; i += width) {
  if (i === 0) {
    pdfPoints.push(jitter);
  } else if (i === 1) {
    pdfPoints.push(1 - jitter);
  } else {
    pdfPoints.push(i);
  }
}

const densityOverlayMark = (script: Pick<ScriptEntry, "stats" | "top5">) => {
  if (script.stats.variance === undefined) {
    return undefined;
  }

  const params = fit(
    script.stats.mean,
    script.stats.variance,
    Math.max.apply(null, script.top5)
  );
  const points = pdfPoints
    .map((p) => p * params.max)
    .map((p) => ({ p, d: pdf(params, p) }));

  return Plot.line(points, { x: "p", y: "d" });
};

const SIXTY_FPS_MS = 1000 / 60;

const fpsTicks = Plot.tickX(
  Array.from(Array(9).keys()).map((_, ix) => ({
    x: ((ix + 1) * SIXTY_FPS_MS) / 10,
  })),
  { stroke: "#f005", x: "x" }
);

function renderPlot(
  script: Pick<ScriptEntry, "stats" | "top5">,
  max: number,
  container: HTMLElement
): void {
  const outlierMark = Plot.dot([0, 1, 2, 3, 4], {
    x: script.top5,
    fill: "black",
    stroke: "black",
    strokeOpacity: 1,
    fillOpacity: 0.1,
    title: (value) =>
      `${script.top5[value].toFixed(2)}ms (${(
        (100 * script.top5[value]) /
        SIXTY_FPS_MS
      ).toFixed(1)}% of 1 render @ 60 FPS)`,
  });
  let marks;
  if (script.stats.samples) {
    marks = [
      fpsTicks,
      Plot.boxX(script.stats.samples, { r: 0 }),
      outlierMark,
      Plot.tickX([{ max: 0 }, { max }], {
        x: "max",
      }),
    ];
  } else {
    marks = [
      Plot.ruleY([script.stats.quantiles], { x1: "0.5", x2: "0.95" }),
      Plot.barX([script.stats.quantiles], {
        x1: "0.5",
        x2: "0.75",
        fill: "#ccc",
      }),
      Plot.tickX([script.stats.quantiles], { x: "0.5", strokeWidth: 2 }),
      Plot.tickX([{ max: 0 }, { max }], {
        x: "max",
      }),
      outlierMark,
      densityOverlayMark(script),
      fpsTicks,
    ];
  }
  const chart = Plot.plot({
    marks,
    x: {
      axis: null,
      domain: [0, max],
    },
    y: {
      axis: null,
    },
    height: 25,
    padding: 0,
  });

  container.appendChild(chart);
}

export function ScriptRow(props: { script: ScriptEntry; max: number }) {
  return (
    <tr>
      <td>
        {props.script.subject.frameName}:{props.script.subject.scriptName} (
        {props.script.subject.addonName ?? "Unknown"})
      </td>
      <td>
        <Show when={props.script.stats.samples || props.script.stats.quantiles}>
          <div ref={renderPlot.bind(null, props.script, props.max)} />
        </Show>
      </td>
    </tr>
  );
}

const CONCERN_OVERRIDE_MS = 1.5;

export default function ScriptList() {
  const recording = useSelectedRecording();

  const max = createMemo(() => {
    const dataMax =
      Math.max.apply(
        null,
        recording()?.data.scripts.flatMap((script) => script.top5) ?? [
          SIXTY_FPS_MS / 1.1,
        ]
      ) * 1.1;

    return Math.max(dataMax, SIXTY_FPS_MS);
  });
  const scripts = createMemo(() => {
    const scripts = recording()?.data.scripts;
    if (!scripts) {
      return [];
    }

    return [...scripts]
      .filter(
        (script) =>
          script.stats.quantiles ||
          Math.max.apply(null, script.top5) >= CONCERN_OVERRIDE_MS
      )
      .sort(
        (a, b) => Math.max.apply(null, b.top5) - Math.max.apply(null, a.top5)
      )
      .slice(0, 100);
  });

  return (
    <table>
      <tbody>
        <tr>
          <td />
          <td>
            <span>0ms</span>
            <span style={{ "text-align": "right", float: "right" }}>
              {max().toFixed(2)}ms
            </span>
          </td>
        </tr>
      </tbody>
      <tbody>
        <For each={scripts()}>
          {(script) => <ScriptRow script={script} max={max()} />}
        </For>
      </tbody>
    </table>
  );
}
