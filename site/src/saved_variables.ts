import { SafeParseReturnType, z } from "zod";
import * as lua from "lua-json";

const strToJson = (data: string) => lua.parse(data.replace("Profiling2_Storage =", "return"));

const luaString = z.string().transform(strToJson);

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
  calls: z.number(),
  commits: z.number(),
  officialTime: z.number().optional(),
  total_time: z.number(),
  top5: z.number().array().max(5),
});

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
    frameName: path.at(0)!,
    framePath: path.slice(1, -1).reverse(),
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

export function parse(data: string): SafeParseReturnType<string, SavedVariables> {
  return luaString.pipe(savedVariables).safeParse(data);
}
