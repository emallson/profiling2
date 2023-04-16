import {
  Accessor,
  ParentProps,
  createContext,
  createSignal,
  useContext,
} from "solid-js";
import * as savedVariables from "./saved_variables";

const SavedVariablesContext = createContext<{
  store?: Accessor<Store>;
  load: (file: File) => void;
}>({
  load: () => {
    /* do nothing */
  },
});

type Store = {
  success?: boolean;
  error?: Error;
  data?: savedVariables.SavedVariables;
};

export function SavedVariablesProvider(props: ParentProps) {
  const [store, setStore] = createSignal<Store>({});
  function load(file: File) {
    file
      .text()
      .then((data) => {
        setStore(savedVariables.parse(data));
      })
      .catch((err) =>
        setStore({
          success: false,
          error: err,
        })
      );
  }

  return (
    <SavedVariablesContext.Provider value={{ store, load }}>
      {props.children}
    </SavedVariablesContext.Provider>
  );
}

export const useSavedVariables = () => useContext(SavedVariablesContext);
