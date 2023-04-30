import { z } from "zod";
import * as parser from "../wasm/pkg/profiling2_wasm";

const bossEncounter = z.object({
  encounterName: z.string(),
  encounterId: z.number(),
  success: z.boolean(),
  difficultyId: z.number(),
  startTime: z.number(),
  endTime: z.number(),
  groupSize: z.number(),
  kind: z.literal("raid"),
});

const dungeonEncounter = z.object({
  mapId: z.number(),
  success: z.boolean(),
  startTime: z.number(),
  endTime: z.number(),
  kind: z.literal("mythicplus"),
  groupSize: z.number(),
});

const manualEncounter = z.object({
  kind: z.literal("manual"),
  startTime: z.number(),
  endTime: z.number(),
});

const trackerData = z.object({
  stats: z.object({
    mean: z.number(),
    variance: z.number().optional(),
    skew: z.number().optional().nullable(),
    samples: z.number().array().optional(),
    quantiles: z
      .record(
        z.string().refine((v) => isFinite(Number(v))),
        z.number()
      )
      .optional(),
  }),
  dependent: z.boolean().optional(),
  calls: z.number(),
  commits: z.number(),
  officialTime: z.number().optional(),
  total_time: z.number(),
  top5: z.number().array().max(5),
});

const decodePathComponent = (s: string) => {
  if (s.startsWith("dec:")) {
    return parser.decompress_string(s.substring(4));
  } else {
    return s;
  }
};

const keypath = z.string().transform((val) => {
  const colons = val.split(":");
  const scriptName = colons.at(-1)!;
  let path = colons.slice(0, -1).join(":").split("/");

  let addonName = undefined;
  if (path[0].startsWith("@")) {
    addonName = path[0].substring(1);
    path = path.slice(1);
  }

  return {
    addonName: addonName!,
    scriptName,
    frameName: decodePathComponent(path.at(-1)!),
    framePath: path.slice(0, -1).map(decodePathComponent),
  };
});

const encounter = z.discriminatedUnion("kind", [bossEncounter, dungeonEncounter, manualEncounter]);

const scriptEntries = z.record(trackerData).transform((data) =>
  Object.entries(data).map(([key, value]) => ({
    subject: keypath.parse(key),
    ...value,
  }))
);

const recording = z.object({
  encounter,
  data: z.object({
    scripts: scriptEntries,
    onUpdateDelay: trackerData.optional(),
  }),
});

const savedVariables = z.object({
  recordings: recording.array(),
});

export type Recording = z.infer<typeof recording>;
export type RaidEncounter = z.infer<typeof bossEncounter>;
export type DungeonEncounter = z.infer<typeof dungeonEncounter>;
export type ManualEncounter = z.infer<typeof manualEncounter>;
export type Encounter = z.infer<typeof encounter>;
export type ScriptEntry = z.infer<typeof scriptEntries>[number];
export type TrackerData = z.infer<typeof trackerData>;
export type SavedVariables = z.infer<typeof savedVariables>;

export function fromScriptEntry([key, data]: [string, TrackerData]): ScriptEntry {
  const subject = keypath.parse(key);
  return {
    ...data,
    subject,
  };
}

export type ParseResult =
  | {
      success: true;
      data: parser.SavedVariablesRef;
    }
  | { success: false; error: unknown };

export function parse(data: string): ParseResult {
  try {
    const result = parser.parse_saved_variables(data);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error };
  }
}
