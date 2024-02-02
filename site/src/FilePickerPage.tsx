import { styled } from "@macaron-css/solid";
import { useSavedVariables } from "./SavedVariablesContext";

const CenteringContainer = styled("div", {
  base: {
    display: "grid",
    alignContent: "center",
    justifyContent: "center",
  },
});

const SelectForm = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25em",
  },
});

export default function FilePickerPage() {
  const { load, store } = useSavedVariables();

  return (
    <CenteringContainer>
      <SelectForm>
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
          <div>{store?.().error?.toString() ?? "Unable to read data"}</div>
        )}
      </SelectForm>
    </CenteringContainer>
  );
}
