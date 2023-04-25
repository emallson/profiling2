import { Show } from "solid-js";

export default function DisplayError(props: { err: unknown }) {
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
