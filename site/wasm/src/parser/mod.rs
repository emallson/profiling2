/// Rather than embed a whole lua parser (of which we need very little), use a basic nom parser for the saved variables table
use std::{borrow::Cow, collections::HashMap, num::TryFromIntError};

use serde::{Deserialize, Serialize};

use self::{
    decompress::{decompress, DecompressionError},
    deserialize::deserialize,
};

pub(crate) mod decompress;
mod deserialize;

/// Any (supported) value type.
#[derive(Debug, PartialEq, Clone)]
pub enum Value<'a> {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(Cow<'a, str>),
    Table(Table<'a>),
}

/// Represents a Lua table. We don't support mixing named keys and implicit keys.
#[derive(Debug, PartialEq, Clone)]
pub enum Table<'a> {
    Empty,
    Named(HashMap<Cow<'a, str>, Value<'a>>),
    Array(Vec<Value<'a>>),
    FloatArray(Vec<f64>),
    MixedTable {
        array: Vec<Value<'a>>,
        named: HashMap<Cow<'a, str>, Value<'a>>,
    },
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum RecordingData<'a> {
    Unparsed(Cow<'a, str>),
    Parsed(ParsedRecording<'a>),
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct ParsedRecording<'a> {
    pub scripts: HashMap<Cow<'a, str>, TrackerData>,
    pub externals: Option<HashMap<Cow<'a, str>, TrackerData>>,
    pub onUpdateDelay: TrackerData,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[allow(non_snake_case)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Encounter<'a> {
    Manual {
        startTime: u64,
        endTime: u64,
    },
    Raid {
        startTime: u64,
        endTime: u64,
        encounterName: Cow<'a, str>,
        encounterId: u64,
        success: bool,
        difficultyId: u64,
        groupSize: u64,
    },
    Dungeon {
        startTime: u64,
        endTime: u64,
        success: bool,
        mapId: u64,
        groupSize: u64,
    },
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct TrackerData {
    pub stats: Stats,
    pub calls: u64,
    pub commits: u64,
    pub officialTime: Option<f64>,
    pub dependent: Option<bool>,
    pub total_time: f64,
    pub top5: Vec<f64>,
}

#[derive(Debug, PartialEq, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub mean: f64,
    pub variance: Option<f64>,
    pub skew: Option<f64>,
    pub samples: Vec<f64>,
    pub quantiles: Option<HashMap<String, f64>>,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct Recording<'a> {
    pub(crate) encounter: Encounter<'a>,
    pub(crate) data: RecordingData<'a>,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct SavedVariables<'a> {
    pub(crate) recordings: Vec<Recording<'a>>,
}

#[derive(thiserror::Error, Debug)]
pub enum SavedVariablesError {
    #[error("Unable to parse {name}. Expected {expected}. Found {actual}")]
    BadType {
        name: &'static str,
        expected: &'static str,
        actual: String,
    },
    #[error("Unable to parse {name}. Key {key} missing.")]
    MissingKey {
        name: &'static str,
        key: &'static str,
    },
    #[error("Unable to parse {expected}. Invalid primitive {actual}.")]
    InvalidPrimitive {
        expected: &'static str,
        actual: String,
    },
    #[error("Unable to parse SavedVariables file. {0}")]
    ParseError(#[from] serde_savedvariables::ParseError),
    #[error("Unable to decompress recording data: {0}")]
    DecompressionError(#[from] DecompressionError),
    #[error("Unable to parse LibSerialize data: {0:?}")]
    DeserializeError(deserialize::SerializeParseError),
    #[error("Unable to cast number from signed to unsigned. {0}")]
    SignCastError(#[from] TryFromIntError),
    #[error("Unable to read input data")]
    Unreadable,
    #[error("Recording data has not been deserialized yet")]
    NotDeserialized,
    #[error("An unrecoverable parse error occurred")]
    Unknown,
}

pub fn parse_saved_variables(data: &str) -> Result<SavedVariables<'_>, SavedVariablesError> {
    Ok(serde_savedvariables::from_str(data)?)
}

pub fn parse_compressed_recording(data: &str) -> Result<ParsedRecording<'_>, SavedVariablesError> {
    let data = decompress(data).map_err(SavedVariablesError::DecompressionError)?;
    let data = deserialize(&data).map_err(SavedVariablesError::DeserializeError)?;
    unimplemented!()
}

#[cfg(test)]
mod test {
    use super::*;
    #[test]
    fn parse_empty() {
        let result = super::parse_saved_variables(
            r#"Profiling2_Storage = {
                ["recordings"] = { -- foo
                }
              }"#,
        );

        match result {
            Ok(value) => assert_eq!(value, SavedVariables { recordings: vec![] }),
            Err(err) => {
                println!("{}", err);
                assert!(false);
            }
        };
    }

    #[test]
    fn parse_apr22_data() {
        let result =
            super::parse_saved_variables(include_str!("../../../test-data/test_apr22_2023.lua"));

        let mut result = result.unwrap();
        assert_eq!(result.recordings.len(), 2);
        match result.recordings.get(1) {
            Some(Recording {
                data: RecordingData::Unparsed(data),
                ..
            }) => {
                assert_eq!(data.len(), 9872);
                let decoded = decompress::decode_for_print(data).expect("to decode successfully");
                assert_eq!(decoded.len(), 7404);
                let decompressed = decompress(data).expect("to decode + decompress successfully");
                assert_eq!(decompressed.len(), 25029);
            }
            _ => assert!(false),
        };

        for recording in &mut result.recordings {
            match &recording.data {
                crate::parser::RecordingData::Unparsed(raw) => {
                    parse_compressed_recording(raw).expect("to succeed");
                }
                _ => {}
            }
        }
    }

    #[test]
    fn parse_apr24_data() {
        let result =
            super::parse_saved_variables(include_str!("../../../test-data/test_apr24_2023.lua"));

        assert!(result.is_ok());

        let mut result = result.unwrap();
        assert_eq!(result.recordings.len(), 6);

        // for recording in &mut result.recordings {
        //     match &recording.data {
        //         crate::parser::RecordingData::Unparsed(raw) => {
        //             parse_compressed_recording(raw).expect("to succeed");
        //         }
        //         _ => {}
        //     }
        // }
    }
}
