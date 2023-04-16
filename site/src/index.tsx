import { render } from "solid-js/web";
import { BetaParams, fit, pdf } from "./beta";
import { styled } from "@macaron-css/solid";

import "../resources/sparkline-font/font-faces.css";
import { createMemo } from "solid-js";

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

const pdfPoints = [];

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

const App = () => {
  const max = 20;
  const mu = 5;
  const v = 5;

  const params = fit(mu, v, max);

  return (
    <>
      <ul>
        <li>{params.alpha}</li>
        <li>{params.beta}</li>
        <li>{pdf(params, mu)}</li>
      </ul>
      <BetaPDF {...params} />
    </>
  );
};

render(() => <App />, document.getElementById("root"));
