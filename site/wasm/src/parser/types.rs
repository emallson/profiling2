use std::{borrow::Cow, collections::HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RecordingData<'a> {
    #[schemars(skip)]
    Unparsed(Cow<'a, str>),
    Parsed(ParsedRecording<'a>),
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ParsedRecording<'a> {
    pub scripts: HashMap<Cow<'a, str>, TrackerData>,
    pub externals: Option<HashMap<Cow<'a, str>, TrackerData>>,
    #[serde(rename = "onUpdateDelay")]
    pub on_update_delay: TrackerData,
    pub sketch_params: Option<SketchParams>,
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SketchParams {
    pub alpha: f64,
    pub gamma: f64,
    pub bin_offset: i64,
    pub trivial_cutoff: f64,
}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[allow(non_snake_case)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[schemars(deny_unknown_fields)]
pub enum Encounter {
    Manual {
        startTime: u64,
        endTime: u64,
    },
    Raid {
        startTime: u64,
        endTime: u64,
        encounterName: String,
        encounterId: u64,
        success: bool,
        difficultyId: u64,
        groupSize: u64,
    },
    #[serde(rename = "mythicplus")]
    Dungeon {
        startTime: u64,
        endTime: u64,
        success: bool,
        mapId: u64,
        groupSize: u64,
    },
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct TrackerCore {
    pub calls: u64,
    pub commits: u64,
    #[serde(rename = "officialTime")]
    pub official_time: Option<f64>,
    pub dependent: Option<bool>,
    pub total_time: f64,
}

#[derive(Deserialize, Eq, Hash, PartialEq)]
#[serde(untagged)]
enum MixedBinKey {
    Integer(u64),
    String(String),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum MixedBinType {
    Array(Vec<f64>),
    Mixed(HashMap<MixedBinKey, f64>),
}

// TODO this should probably have a custom visitor for efficiency, but its such a rare case that we
// take the easy way out.
fn deserialize_bins<'de, D: Deserializer<'de>>(de: D) -> Result<Option<Vec<f64>>, D::Error> {
    match MixedBinType::deserialize(de)? {
        MixedBinType::Array(vec) => Ok(Some(vec)),
        MixedBinType::Mixed(map) => {
            let mut result = vec![];

            for (ix, value) in map.into_iter() {
                let ix = match ix {
                    MixedBinKey::Integer(ix) => ix as usize,
                    MixedBinKey::String(s) => {
                        s.parse::<usize>().map_err(serde::de::Error::custom)?
                    }
                };

                if ix >= result.len() {
                    result.resize(ix + 1, 0.0);
                }
                result[ix] = value;
            }

            Ok(Some(result))
        }
    }
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SketchStats {
    pub outliers: Vec<f64>,
    #[serde(deserialize_with = "deserialize_bins")]
    #[serde(default)]
    pub bins: Option<Vec<f64>>,
    pub count: u64,
    pub trivial_count: u64,
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(deny_unknown_fields)]
pub enum TrackerData {
    OldStyle {
        stats: Stats,
        top5: Vec<f64>,
        #[serde(flatten)]
        core: TrackerCore,
    },
    NewStyle {
        sketch: SketchStats,
        #[serde(flatten)]
        core: TrackerCore,
    },
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct Stats {
    pub mean: f64,
    pub variance: Option<f64>,
    pub skew: Option<f64>,
    pub samples: Vec<f64>,
    pub quantiles: Option<HashMap<String, f64>>,
}

#[derive(Debug, PartialEq, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct Recording<'a> {
    pub(crate) encounter: Encounter,
    pub(crate) data: RecordingData<'a>,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct SavedVariables<'a> {
    pub(crate) recordings: Vec<Recording<'a>>,
}
