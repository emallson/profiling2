import {
  bin_index_for,
  bin_index_to_left_edge,
  defaultSketchParams,
  parse,
} from "./saved_variables";
import * as fs from "fs";
import * as fc from "fast-check";

describe("saved variables parser", () => {
  it.each(fs.readdirSync(__dirname + "/../test-data", "utf8"))(
    "should successfully parse test data: %s",
    (path) => {
      const data = fs.readFileSync(__dirname + "/../test-data/" + path, "utf8");
      const result = parse(data);

      expect(result.success).toBe(true);
    }
  );
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
