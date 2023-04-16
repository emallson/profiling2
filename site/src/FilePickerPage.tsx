import { styled } from "@macaron-css/solid";
import { useSavedVariables } from "./SavedVariablesContext";
import { createEffect } from "solid-js";

const CenteringContainer = styled("div", {
  base: {
    display: "grid",
    alignContent: "center",
    justifyContent: "center",
  },
});

export default function FilePickerPage() {
  const { load, store } = useSavedVariables();

  createEffect(() => {
    console.log(store?.());
  });

  return (
    <CenteringContainer>
      <div>
        <label for="file-picker">Select profiling data</label>
        <input
          type="file"
          id="file-picker"
          onChange={(event) => {
            const file = event.target.files?.[0];
            file && load(file);
          }}
          accept=".lua"
        />
        {store?.().success === false && (
          <div>{store?.().error?.message ?? "Unable to read data"}</div>
        )}
      </div>
    </CenteringContainer>
  );
}
