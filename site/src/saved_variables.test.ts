import { parse } from "./saved_variables";
import * as fs from "fs";

describe("saved variables parser", () => {
  it("should successfully parse the test data", () => {
    const data = fs.readFileSync(__dirname + "/../test-data/test_apr22_2023.lua", "utf8");
    const result = parse(data);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.length()).toBe(2);
      const recording = result.data.get(1)!;
      expect(recording).toBeDefined();
      expect(recording.encounter).toMatchInlineSnapshot(`
        {
          "endTime": 1682193549,
          "kind": "manual",
          "startTime": 1682193529,
        }
      `);
      expect(recording.data.scripts.size).toMatchInlineSnapshot("24");
    }
  });
});
