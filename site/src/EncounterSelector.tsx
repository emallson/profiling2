import {
  Accessor,
  For,
  JSX,
  ParentProps,
  Show,
  createContext,
  createSignal,
  useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Encounter, Recording, SavedVariables } from "./saved_variables";
import { useSavedVariables } from "./SavedVariablesContext";
import { styled } from "@macaron-css/solid";

function encounterName(encounter: Encounter): string {
  switch (encounter.kind) {
    case "raid":
      return encounter.encounterName;
    case "mythicplus":
      return `Dungeon (${encounter.mapId})`;
    case "manual":
      return "Manual Test";
  }
}

function formatStartTime(time: number): string {
  const date = new Date(time * 1000);

  return Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).format(date);
}

const EncounterEntry = (props: {
  encounter: Encounter;
  onClick: () => void;
}) => {
  return (
    <div onClick={() => props.onClick()}>
      <div>{encounterName(props.encounter)}</div>
      <div>{formatStartTime(props.encounter.startTime)}</div>
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
  },
});

const EncounterList = (props: {
  data?: SavedVariables;
  onClick: (recording: Recording) => void;
}) => {
  return (
    <ListContainer>
      <For each={props.data?.recordings}>
        {(recording) => (
          <EncounterEntry
            encounter={recording.encounter}
            onClick={() => props.onClick(recording)}
          />
        )}
      </For>
    </ListContainer>
  );
};

const Context = createContext<{
  selectedRecording?: Accessor<Recording | undefined>;
}>({});

export const useSelectedRecording = () => useContext(Context).selectedRecording;

const PageLayout = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: "1em",
  },
});

export default function EncounterSelector(props: ParentProps): JSX.Element {
  const { store } = useSavedVariables();
  const [recording, setRecording] = createSignal<Recording | undefined>();

  const setSelection = (recording: Recording) => {
    console.log(recording);
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
