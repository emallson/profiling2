import { render } from "solid-js/web";
import { BetaParams, fit, pdf } from "./beta";
import { styled } from "@macaron-css/solid";

import "../resources/sparkline-font/font-faces.css";
import { Show, createMemo } from "solid-js";
import {
  SavedVariablesProvider,
  useSavedVariables,
} from "./SavedVariablesContext";
import FilePickerPage from "./FilePickerPage";
import EncounterSelector, { useSelectedRecording } from "./EncounterSelector";

const sparklineWeights = {
  Bar: ["Narrow", "Medium", "Wide", "Extrawide"],
  Dot: ["Extrasmall", "Small", "Medium", "Large", "Extralarge"],
  Dotline: ["Extrathin", "Thin", "Medium", "Thick", "Extrathick"],
};

const sparklineVariants = {
  type: Object.fromEntries(
    Object.keys(sparklineWeights).map((key) => [key, {}])
  ),
  weight: Object.fromEntries(
    Object.values(sparklineWeights).flatMap((x) =>
      x.map((weight) => [weight, {}])
    )
  ),
};

const sparklineCompoundVariants = Object.entries(sparklineWeights).flatMap(
  ([chartType, weights]) =>
    weights.map((weight) => ({
      variants: {
        type: chartType,
        weight,
      },
      style: {
        fontFamily: `Sparks-${chartType}-${weight}`,
      },
    }))
);

const Sparkline = styled("span", {
  base: { fontVariantLigatures: "normal" },
  variants: sparklineVariants,
  compoundVariants: sparklineCompoundVariants,
});

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
const BetaPDF = (params: BetaParams) => {
  const contents = createMemo(() => {
    const points: number[] = pdfPoints
      .map((p) => p * params.max)
      .map(pdf.bind(null, params));
    const max = Math.max.apply(null, points);
    const scaled = points
      .map((point) => Math.round((point / max) * 100).toFixed(0))
      .join(",");
    return `{${scaled}}`;
  });

  return (
    <Sparkline type="Dotline" weight="Medium">
      {contents()}
    </Sparkline>
  );
};

/**
 * dummy component to make sure things are wired up correctly
 */
const EncounterDisplay = () => {
  const recording = useSelectedRecording();

  return <Show when={recording?.()}>{JSON.stringify(recording?.())}</Show>;
};

const LoadingBlocker = () => {
  const { store } = useSavedVariables();

  return (
    <Show when={store?.().success} fallback={<FilePickerPage />}>
      <EncounterSelector>
        <EncounterDisplay />
      </EncounterSelector>
    </Show>
  );
};

const App = () => {
  return (
    <SavedVariablesProvider>
      <LoadingBlocker />
    </SavedVariablesProvider>
  );
};

const root = document.getElementById("root");
root && render(() => <App />, root);
