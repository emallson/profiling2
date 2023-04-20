import { TreeNode, buildScriptTree, joined_samples, punch } from "./frame_tree";
import { ScriptEntry } from "./saved_variables";
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
    const spy = vi.spyOn(join, "default");

    const samples = joined_samples(roots["Slab"]);
    const samples2 = joined_samples(roots["Slab"]);

    expect(spy).toHaveBeenCalledOnce();
    expect(samples).toBe(samples2);
  });
});
