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

const densityOverlayMark = (script: ScriptEntry) => {
  if (script.stats.variance === undefined) {
    return undefined;
  }

  const params = fit(
    script.stats.mean,
    script.stats.variance,
    Math.max.apply(null, script.top5)
  );
  script.stats.skew && console.log(skew_err(params, script.stats.skew));
  const points = pdfPoints
    .map((p) => p * params.max)
    .map((p) => ({ p, d: pdf(params, p) }));

  return Plot.line(points, { x: "p", y: "d" });
};

function renderPlot(
  script: ScriptEntry,
  max: number,
  container: HTMLElement
): void {
  const chart = Plot.plot({
    marks: [
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
      Plot.dot([0, 1, 2, 3, 4], { x: script.top5 }),
      densityOverlayMark(script),
    ],
    x: {
      axis: null,
      domain: [0, max],
    },
    y: {
      axis: null,
    },
    height: 20,
    padding: 0,
  });

  container.appendChild(chart);
}

export function ScriptRow(props: { script: ScriptEntry; max: number }) {
  return (
    <tr style={{ height: "2em" }}>
      <td>
        {props.script.subject.frameName}:{props.script.subject.scriptName} (
        {props.script.subject.addonName ?? "Unknown"})
      </td>
      <td>
        <Show when={props.script.stats.quantiles}>
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
        recording()?.data.scripts.flatMap((script) => script.top5) ?? [2 / 1.1]
      ) * 1.1;

    return Math.max(dataMax, 2);
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
