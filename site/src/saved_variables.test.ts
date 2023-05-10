import {
  bin_index_for,
  bin_index_to_left_edge,
  defaultSketchParams,
  parse,
} from "./saved_variables";
import * as fs from "fs";
import * as fc from "fast-check";

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
      expect(Object.keys(recording.data.scripts).length).toMatchInlineSnapshot("24");
    }
  });
});

describe("bin indexing", () => {
  it("should have a proper inverse", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), fc.context(), (x, ctx) => {
        const left = bin_index_for(bin_index_to_left_edge(x));
        ctx.log(bin_index_to_left_edge(x).toString());
        ctx.log(left.toString());

        return left === x;
      })
    );
  });

  it("should have the expected 0 value", () => {
    expect(bin_index_to_left_edge(0)).toBe(defaultSketchParams.trivial_cutoff);
  });

  it("should behave as expected for negative values", () => {
    expect(bin_index_for(bin_index_to_left_edge(-2))).toBe(-2);
  });
});
