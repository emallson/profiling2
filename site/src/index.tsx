import { render } from "solid-js/web";

import { ErrorBoundary, Show } from "solid-js";
import { SavedVariablesProvider, useSavedVariables } from "./SavedVariablesContext";
import FilePickerPage from "./FilePickerPage";
import EncounterSelector from "./EncounterSelector";
import { RootSummary } from "./NodeSummary";
import DisplayError from "./DisplayError";
import { globalStyle } from "@macaron-css/core";

globalStyle("body", {
  margin: 0,
});

const LoadingBlocker = () => {
  const { store } = useSavedVariables();

  return (
    <Show when={store?.().success} fallback={<FilePickerPage />}>
      <EncounterSelector>
        <RootSummary />
      </EncounterSelector>
    </Show>
  );
};

const App = () => {
  return (
    <ErrorBoundary fallback={(err) => <DisplayError err={err} />}>
      <SavedVariablesProvider>
        <LoadingBlocker />
      </SavedVariablesProvider>
    </ErrorBoundary>
  );
};

const root = document.getElementById("root")!;
render(() => <App />, root);
