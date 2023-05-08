import {
  TreeNode,
  buildScriptTree,
  joined_samples,
  mergeSketchDependent,
  mergeSketchIndependent,
  punch,
} from "./frame_tree";
import { ScriptEntry, SketchStats, bin_index_for, bin_index_to_left_edge } from "./saved_variables";
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
  it("should handle the singleton case, normalizing the data by count", () => {
    // ignoring outliers for now
    const a: SketchStats = {
      count: 10,
      trivial_count: 5,
      bins: [0, 1, 2, 1, 1, 0],
      outliers: [],
    };

    expect(mergeSketchIndependent([a])).toStrictEqual({
      count: 10,
      trivial_count: 0.5,
      bins: [0, 0.1, 0.2, 0.1, 0.1, 0],
      outliers: [],
    });
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
      count: 10,
      trivial_count: 2,
      bins: [1, 1, 2, 1, 0],
      outliers: [8, 9, 10],
    };

    const merged = mergeSketchIndependent([a, b]);
    const pa = 0.5;
    const pb = 0.5;
    const pa_trivial = 0.5;
    const pb_trivial = 0.2;
    const p_none = (1 - pa) * (1 - pb);

    // the combined weight of each mode of the new sketch should be the weighted average of the
    // corresponding modes in each component sketch. since by construction a and b have equal
    // weight, this is just the simple average. this lets us check the behavior.

    expect(merged.trivial_count).toBeCloseTo(
      (a.trivial_count / a.count + b.trivial_count / b.count) / 2
    );

    console.log(
      (1 - pa) * pb * pb_trivial + (1 - pb) * pa * pa_trivial + pa * pa_trivial * pb * pb_trivial
    );

    // expect(merged).toMatchObject({
    //   count: 1,
    //   trivial_count: (1 - pa + pa * pa_trivial) * (1 - pb + pb * pb_trivial) - p_none,
    //   outliers: [8, 9, 10],
    // });

    const outlier_density = pb * 0.3;
    expect(
      (merged.bins?.reduce((a, b) => a + b) ?? 0) + merged.trivial_count + outlier_density
    ).toBeCloseTo(1);
    expect(merged.bins).toMatchInlineSnapshot(`
      [
        0.025,
        0.04375,
        0.0875,
        0.04375,
        0.018749999999999996,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0.005000000000000001,
        0.015000000000000003,
        0.010000000000000002,
        0.0012500000000000002,
        0,
      ]
    `);
  });
});
