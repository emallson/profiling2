import {
  TreeNode,
  buildScriptTree,
  joined_samples,
  mergeSketchDependent,
  mergeSketchIndependent,
  mergeSketchPairIndependent,
  punch,
} from "./frame_tree";
import {
  ScriptEntry,
  SketchStats,
  bin_index_for,
  bin_index_to_left_edge,
  defaultSketchParams,
} from "./saved_variables";
import * as join from "./join_frames";

const anon_OnUpdate: Pick<ScriptEntry, "subject"> = {
  subject: {
    addonName: "Test",
    framePath: [],
    frameName: "Anonymous",
    scriptName: "OnUpdate",
  },
};

const slab_one_hp = {
  subject: {
    addonName: "Slab",
    framePath: ["Slab1"],
    frameName: "Slab1HealthBar",
    scriptName: "OnEvent",
  },
  stats: {
    samples: [1],
  },
  commits: 1,
};

const slab_one_cast = {
  subject: {
    addonName: "Slab",
    framePath: ["Slab1"],
    frameName: "Slab1CastBar",
    scriptName: "OnEvent",
  },
  stats: {
    samples: [2],
  },
  commits: 10,
};

const slab_two_hp: Pick<ScriptEntry, "subject"> = {
  subject: {
    addonName: "Slab",
    framePath: ["Slab2"],
    frameName: "Slab2HealthBar",
    scriptName: "OnEvent",
  },
};

const slab_two_cast: Pick<ScriptEntry, "subject"> = {
  subject: {
    addonName: "Slab",
    framePath: ["Slab2"],
    frameName: "Slab2CastBar",
    scriptName: "OnEvent",
  },
};

describe("buildScriptTree", () => {
  it("should handle the trivial 1-script case", () => {
    const roots = buildScriptTree([anon_OnUpdate as ScriptEntry]);

    expect(roots).toMatchInlineSnapshot(`
      {
        "Test": {
          "children": {
            "Anonymous": {
              "children": {
                "OnUpdate": {
                  "key": "OnUpdate",
                  "parent": [Circular],
                  "self": {
                    "subject": {
                      "addonName": "Test",
                      "frameName": "Anonymous",
                      "framePath": [],
                      "scriptName": "OnUpdate",
                    },
                  },
                },
              },
              "key": "Anonymous",
              "parent": [Circular],
              "self": undefined,
            },
          },
          "key": "Test",
          "parent": undefined,
          "self": undefined,
        },
      }
    `);
  });

  it("should throw an error if duplicate leaves are found", () => {
    expect(() =>
      buildScriptTree([anon_OnUpdate as ScriptEntry, anon_OnUpdate as ScriptEntry])
    ).toThrowError("duplicate leaf found");
  });

  it("should build siblings correctly", () => {
    const roots = buildScriptTree([
      slab_one_hp,
      slab_two_hp,
      slab_one_cast,
      slab_two_cast,
    ] as ScriptEntry[]);

    const one = {
      hp: punch(roots, slab_one_hp as ScriptEntry),
      cast: punch(roots, slab_one_cast as ScriptEntry),
    };

    expect(one.hp?.parent?.parent).toBeDefined();
    expect(one.cast?.parent?.parent).toBe(one.hp?.parent?.parent);
  });
});

describe("joined_samples", () => {
  it("should return the node's samples for a leaf", () => {
    const samples = [1, 2, 3];
    const leaf: TreeNode = {
      key: slab_one_hp.subject.scriptName,
      self: { ...slab_one_hp, stats: { samples } } as ScriptEntry,
    };

    expect(joined_samples(leaf)).toBe(samples);
  });

  it("should return the sum sample of the leaves below the node", () => {
    // we assume `join_data` works as expected
    const roots = buildScriptTree([slab_one_hp, slab_one_cast] as ScriptEntry[]);
    const samples = joined_samples(roots["Slab"]);

    expect(samples).toSatisfy((val: unknown[]) => val.every((v) => typeof v === "number" && v > 0));
  });

  it("should store the sum samples on the branches of the tree to avoid recomputation", () => {
    const roots = buildScriptTree([slab_one_hp, slab_one_cast] as ScriptEntry[]);
    const spy = vi.spyOn(join, "join_data");

    const samples = joined_samples(roots["Slab"]);
    const samples2 = joined_samples(roots["Slab"]);

    expect(spy).toHaveBeenCalledOnce();
    expect(samples).toBe(samples2);
  });
});

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
