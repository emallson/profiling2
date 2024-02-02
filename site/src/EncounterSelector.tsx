import {
  Accessor,
  JSX,
  ParentProps,
  Show,
  createContext,
  createMemo,
  createSignal,
  useContext,
} from "solid-js";
import { Encounter } from "./saved_variables";
import { useSavedVariables } from "./SavedVariablesContext";
import { styled } from "@macaron-css/solid";
import { style } from "@macaron-css/core";
import { Range } from "@solid-primitives/range";
import { RecordingRef, SavedVariablesRef } from "../wasm/pkg/profiling2_wasm";

export function encounterName(encounter: Encounter): string {
  switch (encounter.kind) {
    case "raid":
      return encounter.encounterName;
    case "mythicplus":
      return `Dungeon (${encounter.mapId})`;
    case "manual":
      return "Manual Test";
  }
}

export function formatTimestamp(time: number): string {
  const date = new Date(time * 1000);

  return Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).format(date);
}

const baseStyle = style({
  ":hover": {
    backgroundColor: "#eef",
  },
  padding: "0.25em 0.1em",
});

const selectedStyle = style([
  baseStyle,
  {
    backgroundColor: "#eee",
  },
]);

const EncounterEntry = (props: { encounter: Encounter; onClick: () => void }) => {
  const recording = useSelectedRecording();
  const style = createMemo(() =>
    recording()?.encounter.startTime === props.encounter.startTime ? selectedStyle : baseStyle,
  );
  return (
    <div class={style()} onClick={() => props.onClick()}>
      <div>{encounterName(props.encounter)}</div>
      <div>{formatTimestamp(props.encounter.startTime)}</div>
    </div>
  );
};

const ListContainer = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "1em",
    borderRight: "1px solid #333",
    width: "max-content",
    padding: "0 1em",
    maxHeight: "98vh",
    overflowY: "auto",
  },
});

const EncounterList = (props: {
  data?: SavedVariablesRef;
  onClick: (recording: RecordingRef) => void;
}) => {
  return (
    <ListContainer>
      <Range to={props.data?.length() ?? 0}>
        {(index) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const recording = props.data!.get(index)!;
          return (
            <EncounterEntry
              encounter={recording.encounter}
              onClick={() => props.onClick(recording)}
            />
          );
        }}
      </Range>
    </ListContainer>
  );
};

const Context = createContext<{
  selectedRecording?: Accessor<RecordingRef | undefined>;
}>({});

export const useSelectedRecording = () => {
  const value = createMemo(() => {
    const recording = useContext(Context).selectedRecording;
    return recording?.();
  });

  return value;
};

const PageLayout = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: "1em",
    maxWidth: "100vw",
  },
});

export default function EncounterSelector(props: ParentProps): JSX.Element {
  const { store } = useSavedVariables();
  const [recording, setRecording] = createSignal<RecordingRef | undefined>();

  const setSelection = (recording: RecordingRef) => {
    setRecording(recording);
  };

  return (
    <Show when={store?.().success}>
      <Context.Provider
        value={{
          selectedRecording: recording,
        }}
      >
        <PageLayout>
          <EncounterList data={store?.().data} onClick={setSelection} />
          <div>{props.children}</div>
        </PageLayout>
      </Context.Provider>
    </Show>
  );
}
