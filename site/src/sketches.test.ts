import { SketchStats, defaultSketchParams } from "./saved_variables";
import { mergeSketchDependent, mergeSketchIndependent } from "./sketches";

describe("merge dependent sketches", () => {
  it("should be a simple sum of bins and merge of outliers", () => {
    const a: SketchStats = {
      count: 200,
      trivial_count: 90,
      bins: [25, 50, 25, 0, 0],
      outliers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    };

    const b: SketchStats = {
      count: 12,
      trivial_count: 0,
      outliers: [1, 1, 1, 1, 1, 1, 1, 11, 1, 1, 1, 1, 1, 1],
      bins: [1, 1],
    };

    const result = mergeSketchDependent([a, b]);

    expect(result).toStrictEqual({
      count: 212,
      trivial_count: 90,
      bins: [26, 51, 25, 0, 0],
      outliers: a.outliers.concat(b.outliers),
    });
  });
});

describe("merge independent histograms", () => {
  it("should handle the singleton case", () => {
    // ignoring outliers for now
    const a: SketchStats = {
      count: 10,
      trivial_count: 5,
      bins: [0, 1, 2, 1, 1, 0],
      outliers: [],
    };

    expect(mergeSketchIndependent([a], defaultSketchParams)).toStrictEqual(a);
  });

  it("should be able to merge two sketches with only trivial/outlier cases", () => {
    const a = {
      count: 10,
      trivial_count: 5,
      outliers: [1, 2, 3, 4, 5],
    };
    const b = {
      count: 10,
      trivial_count: 2,
      outliers: [1, 2, 3, 4, 5, 6, 7, 8],
    };

    const merged = mergeSketchIndependent([a, b], defaultSketchParams);

    expect(merged.trivial_count + (merged.bins?.reduce((a, b) => a + b, 0) ?? 0)).toBeCloseTo(
      merged.count
    );
  });

  it("should be able to merge the bins of two basic sketches", () => {
    // still ignoring outliers

    const a = {
      count: 10,
      trivial_count: 5,
      bins: [0, 1, 2, 1, 1, 0],
      outliers: [],
    };

    const b = {
      count: 11,
      trivial_count: 2,
      bins: [1, 1, 2, 1, 0],
      outliers: [8, 9, 10, 11],
    };

    const merged = mergeSketchIndependent([a, b], defaultSketchParams);

    // the sum of trivial + bins + should equal the total count.
    // outliers are duplicated into bins as part of the merge process.
    expect(merged.trivial_count + (merged.bins?.reduce((a, b) => a + b, 0) ?? 0)).toBeCloseTo(
      merged.count
    );
  });

  it("should successfully handle repeat merges of low-cardinality data", () => {
    // this is a real sample that broke things
    const data = [
      { outliers: [0.7788000106811523, 0.9202001094818115], count: 2, trivial_count: 0 },
      { outliers: [], count: 2, trivial_count: 2 },
      {
        outliers: [
          0.8173999786376953, 0.8588998317718506, 0.8712999820709229, 1.152899980545044,
          1.0357000827789307,
        ],
        count: 5,
        trivial_count: 0,
      },
      { outliers: [], count: 5, trivial_count: 5 },
      { outliers: [0.9728999137878418], count: 1, trivial_count: 0 },
      { outliers: [], count: 1, trivial_count: 1 },
    ];

    const merged = mergeSketchIndependent(data, defaultSketchParams);

    expect(merged.trivial_count + (merged.bins?.reduce((a, b) => a + b, 0) ?? 0)).toBeCloseTo(
      merged.count
    );
  });
});
