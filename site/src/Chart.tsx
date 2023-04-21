import { PlotOptions, plot } from "@observablehq/plot";
import { Accessor, createEffect, createSignal } from "solid-js";

function observeResize(fn: ResizeObserverCallback): (el: HTMLElement) => void {
  const [el, setEl] = createSignal<HTMLElement | undefined>(undefined);
  const observer = new ResizeObserver(fn);

  createEffect(() => {
    observer.disconnect();
    const target = el();

    if (target) {
      observer.observe(target);
    }
  });

  return setEl;
}

export function observeSize(): {
  height: Accessor<number>;
  width: Accessor<number>;
  observe: (el: HTMLElement) => void;
} {
  const [height, setHeight] = createSignal(0);
  const [width, setWidth] = createSignal(0);

  const observe = observeResize((resize) => {
    const target = resize.at(-1)?.target as HTMLElement | undefined;
    if (target !== undefined) {
      setHeight(target.offsetHeight);
      setWidth(target.offsetWidth);
    }
  });

  return { height, width, observe };
}

export default function Chart(props: { plot: PlotOptions }) {
  const [el, setEl] = createSignal<HTMLElement | undefined>(undefined);
  const { height: obsHeight, width: obsWidth, observe } = observeSize();

  createEffect(() => {
    const height = props.plot.height ?? obsHeight();
    const width = props.plot.width ?? obsWidth();
    const svg = plot({ ...props.plot, height, width });
    el()?.replaceChildren(svg);
  });

  return (
    <div
      ref={(target) => {
        setEl(target);
        observe(target);
      }}
    />
  );
}
