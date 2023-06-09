import { z } from "zod";
import * as parser from "../wasm/pkg/profiling2_wasm";
import type * as recording from "../wasm/pkg/parsed_recording";
export type * from "../wasm/pkg/parsed_recording";

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

export type RaidEncounter = Extract<recording.Encounter, { kind: "raid" }>;
export type DungeonEncounter = Extract<recording.Encounter, { kind: "mythicplus" }>;
export type ManualEncounter = Extract<recording.Encounter, { kind: "manual" }>;
export type OldTrackerData = Extract<recording.TrackerData, { stats: recording.Stats }>;
export type NewTrackerData = Extract<recording.TrackerData, { sketch: recording.SketchStats }>;
export type ScriptEntry = recording.TrackerData & {
  subject: z.infer<typeof keypath>;
};

export function isNewTrackerData(data: recording.TrackerData): data is NewTrackerData {
  return "sketch" in data;
}

export function isOldTrackerData(data: recording.TrackerData): data is OldTrackerData {
  return !isNewTrackerData(data);
}

export function fromScriptEntry([key, data]: [string, recording.TrackerData]): ScriptEntry {
  const subject = keypath.parse(key);
  return {
    ...data,
    subject,
  };
}

const ALPHA = 0.05;
const GAMMA = (1 + ALPHA) / (1 - ALPHA);
const BIN_OFFSET = Math.ceil(Math.log(0.5) / Math.log(GAMMA));
const TRIVIAL_TIME = Math.pow(GAMMA, BIN_OFFSET);

export const defaultSketchParams: recording.SketchParams = {
  alpha: ALPHA,
  gamma: GAMMA,
  bin_offset: BIN_OFFSET,
  trivial_cutoff: TRIVIAL_TIME,
};

export function bin_index_to_left_edge(
  ix: number,
  { gamma, bin_offset }: recording.SketchParams = defaultSketchParams
): number {
  return Math.pow(gamma, ix + bin_offset);
}

/**
 * Inverse of `bin_index_to_left_edge` with some thresholding.
 */
export function bin_index_for(
  value: number,
  { gamma, bin_offset }: recording.SketchParams = defaultSketchParams
): number {
  const target = Math.fround(Math.log(value) / Math.log(gamma));
  return Math.floor(target - bin_offset);
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
