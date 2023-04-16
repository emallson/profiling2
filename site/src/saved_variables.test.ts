import { parse } from "./saved_variables";
import * as fs from "fs";

describe("saved variables parser", () => {
  it("should successfully parse the test data", () => {
    const data = fs.readFileSync(
      __dirname + "/../test-data/test_apr16_2023.lua",
      "utf8"
    );
    const result = parse(data);

    expect(result.success).toBe(true);
  });
});
