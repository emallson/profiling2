import { render } from "solid-js/web";

import { Show } from "solid-js";
import { SavedVariablesProvider, useSavedVariables } from "./SavedVariablesContext";
import FilePickerPage from "./FilePickerPage";
import EncounterSelector from "./EncounterSelector";
import EncounterDetails from "./EncounterDetails";
import ScriptList from "./ScriptList";
import ScriptTree from "./ScriptTree";

const LoadingBlocker = () => {
  const { store } = useSavedVariables();

  return (
    <Show when={store?.().success} fallback={<FilePickerPage />}>
      <EncounterSelector>
        <EncounterDetails />
        <ScriptTree />
        <ScriptList />
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

const root = document.getElementById("root")!;
render(() => <App />, root);
