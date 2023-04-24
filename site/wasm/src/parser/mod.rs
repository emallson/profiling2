/// Rather than embed a whole lua parser (of which we need very little), use a basic nom parser for the saved variables table
use std::{borrow::Cow, collections::HashMap, num::TryFromIntError};

use nom::{
    branch::alt,
    bytes::complete::{escaped, tag, take_while1},
    character::complete::{i64 as parse_i64, line_ending, multispace1, none_of, one_of},
    combinator::{complete, eof, map, not, opt, recognize},
    error::{convert_error, VerboseError},
    multi::{fold_many0, many0, separated_list1},
    number::complete::double,
    sequence::{delimited, separated_pair, terminated},
};
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;

use self::{
    decompress::{decompress, DecompressionError},
    deserialize::deserialize,
};

mod decompress;
mod deserialize;

type IResult<'a, O> = nom::IResult<&'a str, O, VerboseError<&'a str>>;

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

fn nil(input: &str) -> IResult<Value> {
    map(tag("nil"), |_| Value::Nil)(input)
}

fn boolean(input: &str) -> IResult<Value> {
    alt((
        map(tag("true"), |_| Value::Bool(true)),
        map(tag("false"), |_| Value::Bool(false)),
    ))(input)
}

fn int(input: &str) -> IResult<Value> {
    map(terminated(parse_i64, not(tag("."))), Value::Int)(input)
}

fn float(input: &str) -> IResult<Value> {
    map(double, Value::Float)(input)
}

fn string_double(input: &str) -> IResult<Value> {
    map(
        delimited(
            one_of("\""),
            escaped(none_of(r#"""#), '\\', one_of(r#"""#)),
            one_of("\""),
        ),
        |s| Value::String(Cow::Borrowed(s)),
    )(input)
}

fn string_single(input: &str) -> IResult<Value> {
    map(
        delimited(
            one_of("'"),
            escaped(none_of(r#"'"#), '\\', one_of(r#"'"#)),
            one_of("'"),
        ),
        |s| Value::String(Cow::Borrowed(s)),
    )(input)
}

fn comment(input: &str) -> IResult<&str> {
    delimited(
        tag("--"),
        recognize(many0(none_of("\r\n"))),
        alt((eof, line_ending)),
    )(input)
}

/// Lax identifier parser. Allows technically banned identifiers like `2ident`, but we don't
/// care
fn identifier(input: &str) -> IResult<Cow<str>> {
    map(
        take_while1::<_, &str, _>(|c| c.is_alphanumeric() || c == '_'),
        Cow::Borrowed,
    )(input)
}

/// Represents a Lua table. We don't support mixing named keys and implicit keys.
#[derive(Debug, PartialEq, Clone)]
pub enum Table<'a> {
    Empty,
    Named(HashMap<Cow<'a, str>, Value<'a>>),
    Array(Vec<Value<'a>>),
    MixedTable {
        array: Vec<Value<'a>>,
        named: HashMap<Cow<'a, str>, Value<'a>>,
    },
}

fn table_empty(input: &str) -> IResult<Table> {
    map(delimited(tag("{"), spacing, tag("}")), |_| Table::Empty)(input)
}

fn spacing(input: &str) -> IResult<()> {
    fold_many0(alt((multispace1, comment)), || (), |_, _| ())(input)
}

/// A combinator that takes a parser `inner` and produces a parser that also consumes both leading and
/// trailing whitespace, returning the output of `inner`.
/// Taken from the Nom recipes doc
fn ws<'a, F, O>(inner: F) -> impl FnMut(&'a str) -> IResult<'a, O>
where
    F: FnMut(&'a str) -> IResult<'a, O>,
{
    delimited(spacing, inner, spacing)
}

fn table_string_key(input: &str) -> IResult<Cow<str>> {
    map(
        delimited(tag("["), alt((string_single, string_double)), tag("]")),
        |v| match v {
            Value::String(s) => s,
            _ => unreachable!(),
        },
    )(input)
}

fn named_pair(input: &str) -> IResult<(Cow<str>, Value)> {
    separated_pair(alt((table_string_key, identifier)), ws(tag("=")), value)(input)
}

fn table_named(input: &str) -> IResult<Table> {
    map(
        delimited(
            ws(tag("{")),
            terminated(separated_list1(ws(tag(",")), named_pair), opt(ws(tag(",")))),
            ws(tag("}")),
        ),
        |entries| {
            let map = entries.into_iter().collect::<HashMap<_, _>>();
            Table::Named(map)
        },
    )(input)
}

fn table_array(input: &str) -> IResult<Table> {
    map(
        delimited(
            ws(tag("{")),
            terminated(separated_list1(ws(tag(",")), value), opt(ws(tag(",")))),
            ws(tag("}")),
        ),
        Table::Array,
    )(input)
}

fn table(input: &str) -> IResult<Value> {
    map(alt((table_empty, table_array, table_named)), Value::Table)(input)
}

fn value(input: &str) -> IResult<Value> {
    alt((
        nil,
        boolean,
        int,
        float,
        string_double,
        string_single,
        table,
    ))(input)
}

/// SavedVariables files begin with `<variable> = <table>`.
/// Read it.
fn initial_assignment(input: &str) -> IResult<Value> {
    complete(map(ws(named_pair), |(_, v)| v))(input)
}

macro_rules! from_value {
          (ref $name:ident ($value:ident) $body:block) => {
              impl<'a> TryFrom<Value<'a>> for &'a $name {
                type Error = SavedVariablesError;

                fn try_from($value: Value<'a>) -> Result<Self, Self::Error> $body
              }
          };
          (owned $name:ident ($value:ident) $body:block) => {
              impl<'a> TryFrom<Value<'a>> for $name {
                type Error = SavedVariablesError;

                fn try_from($value: Value<'a>) -> Result<Self, Self::Error> $body
              }
          };
            ($name:ident ($value:ident) $body:block) => {
              impl<'a> TryFrom<Value<'a>> for $name<'a> {
                type Error = SavedVariablesError;

                fn try_from($value: Value<'a>) -> Result<Self, Self::Error> $body
              }
            };
        }

macro_rules! try_from_keys {
          ($target:ident($source:ident) { $($key:ident),+$(; $($optKey:ident),*)? }) => {
            Ok($target {
              $($key: $source.remove(stringify!($key)).ok_or(SavedVariablesError::MissingKey {
                name: stringify!($target),
                key: stringify!($key),
              }).and_then(|v| v.try_into())?, )+

              $($($optKey: match $source.remove(stringify!($optKey)) { Some(v) => Some(v.try_into()?), None => None }, )+ )?
            })
          }
        }

macro_rules! try_from_struct {
            ($(($kind:ident))? $target:ident $keys:tt) => {
              from_value!($($kind)? $target (value) {
                match value {
                  Value::Table(Table::Named(mut data)) => try_from_keys!($target(data) $keys),
                  other => Err(SavedVariablesError::BadType { name: stringify!($target), expected: "Associative Table", actual: format!("{:?}", other) }),
                }});
              };
        }

#[derive(Debug, PartialEq)]
pub enum RecordingData<'a> {
    Unparsed(Cow<'a, str>),
    Parsed(ParsedRecording<'a>),
}

from_value!(RecordingData(value) {
  match value {
    Value::String(data) => Ok(RecordingData::Unparsed(data)),
    value @ Value::Table(_) => Ok(RecordingData::Parsed(value.try_into()?)),
    other => Err(SavedVariablesError::BadType {
      name: "RecordingData",
      expected: "String or Table",
      actual: format!("{:?}", other),
    })
  }
});

#[derive(Debug, PartialEq, Clone, Serialize)]
#[allow(non_snake_case)]
pub struct ParsedRecording<'a> {
    pub scripts: HashMap<Cow<'a, str>, TrackerData>,
    pub onUpdateDelay: TrackerData,
}

from_value!(ParsedRecording(value) {
  match value {
    Value::Table(Table::Named(mut map)) => try_from_keys!(ParsedRecording(map) { scripts, onUpdateDelay }),
    _ => Err(SavedVariablesError::BadType { name: "ParsedRecording", expected: "Named Table", actual: format!("{:?}", value) })
  }
});

#[derive(Debug, PartialEq, Serialize)]
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

from_value!(Encounter(value) {
  use Encounter::*;
  match value {
    Value::Table(Table::Named(mut data)) => {
      let key = data.remove("kind");
      match key {
        None => {
          Err(SavedVariablesError::MissingKey { name: "Encounter", key: "kind" })
        },
        Some(Value::String(value)) => {
          match &*value {
            "manual" => try_from_keys!(Manual(data) { startTime, endTime }),
            "mythicplus" => try_from_keys!(Dungeon(data) { startTime, endTime, success, mapId, groupSize }),
            "raid" => try_from_keys!(Raid(data) { startTime, endTime, encounterName, encounterId, success, difficultyId, groupSize }),
            _ => unreachable!(),
          }
        },
        Some(value) => Err(SavedVariablesError::BadType { name: "EncounterType", expected: "manual, mythicplus, or raid", actual: format!("{:?}", value) })
      }
    },
    other => Err(SavedVariablesError::BadType { name: "Encounter", expected: "Associative Table", actual: format!("{:?}", other) }),
  }
});

#[derive(Debug, PartialEq, Clone, Serialize)]
#[allow(non_snake_case)]
#[wasm_bindgen]
pub struct TrackerData {
    stats: Stats,
    calls: u64,
    commits: u64,
    officialTime: Option<f64>,
    total_time: f64,
    top5: Vec<f64>,
}

from_value!(owned u64(value) {
  match value {
    Value::Int(v) => v.try_into().map_err(SavedVariablesError::from),
    _ => Err(SavedVariablesError::InvalidPrimitive { expected: "integer", actual: format!("{:?}", value) }),
  }
});

from_value!(owned f64(value) {
  match value {
    Value::Float(v) => Ok(v),
    // allow promoting ints to floats
    Value::Int(v) => Ok(v as f64),
    _ => Err(SavedVariablesError::InvalidPrimitive { expected: "float", actual: format!("{:?}", value) }),
  }
});

from_value!(owned bool(value) {
  match value {
    Value::Bool(v) => Ok(v),
    _ => Err(SavedVariablesError::InvalidPrimitive { expected: "bool", actual:  format!("{:?}", value)}),
  }
});

impl<'a> TryFrom<Value<'a>> for Cow<'a, str> {
    type Error = SavedVariablesError;

    fn try_from(value: Value<'a>) -> Result<Self, Self::Error> {
        match value {
            Value::String(s) => Ok(s),
            _ => Err(SavedVariablesError::InvalidPrimitive {
                expected: "string",
                actual: format!("{:?}", value),
            }),
        }
    }
}

impl<'a, V: TryFrom<Value<'a>, Error = SavedVariablesError>> TryFrom<Value<'a>> for Vec<V> {
    type Error = SavedVariablesError;

    fn try_from(value: Value<'a>) -> Result<Self, Self::Error> {
        match value {
            Value::Table(Table::Array(vec)) => vec.into_iter().map(V::try_from).collect(),
            Value::Table(Table::Empty) => Ok(vec![]),
            _ => Err(SavedVariablesError::BadType {
                name: "Array",
                expected: "Monotyped Table",
                actual: format!("{:?}", value),
            }),
        }
    }
}

impl<'a, V: TryFrom<Value<'a>, Error = SavedVariablesError>> TryFrom<Value<'a>>
    for HashMap<Cow<'a, str>, V>
{
    type Error = SavedVariablesError;

    fn try_from(value: Value<'a>) -> Result<Self, Self::Error> {
        match value {
            Value::Table(Table::Named(data)) => {
                data.into_iter()
                    .try_fold(HashMap::new(), |mut map, (k, v)| {
                        map.insert(k, V::try_from(v)?);
                        Ok(map)
                    })
            }
            Value::Table(Table::Empty) => Ok(HashMap::new()),
            _ => Err(SavedVariablesError::BadType {
                name: "HashMap",
                expected: "Monotyped Associative Table",
                actual: format!("{:?}", value),
            }),
        }
    }
}

// blanket impl conflict. not happy about that
macro_rules! try_optional_value {
    ($name:ty) => {
        impl<'a> TryFrom<Value<'a>> for Option<$name> {
            type Error = SavedVariablesError;

            fn try_from(value: Value<'a>) -> Result<Self, Self::Error> {
                match value {
                    Value::Nil => Ok(None),
                    other => Ok(Some(other.try_into()?)),
                }
            }
        }
    };
}

try_optional_value!(f64);

try_from_struct!((owned) TrackerData { stats, calls, commits, total_time, top5; officialTime });

#[derive(Debug, PartialEq, Clone, Serialize)]
#[wasm_bindgen]
pub struct Stats {
    mean: f64,
    variance: Option<f64>,
    skew: Option<f64>,
    samples: Vec<f64>,
}

try_from_struct!((owned) Stats { mean, samples; variance, skew });

#[derive(Debug, PartialEq)]
pub struct Recording<'a> {
    pub(crate) encounter: Encounter<'a>,
    pub(crate) data: RecordingData<'a>,
}

from_value!(Recording(value) {
  match value {
    Value::Table(Table::Named(mut map)) => {
      let encounter = Encounter::try_from(map.remove("encounter").ok_or(SavedVariablesError::MissingKey { name: "Recording", key: "encounter" })?)?;
      let data = RecordingData::try_from(map.remove("data").ok_or(SavedVariablesError::MissingKey { name: "Recording", key: "data" })?)?;

      Ok(Recording { encounter, data })
    },
    other => Err(SavedVariablesError::BadType { name: "Recording", expected: "Associative Table", actual: format!("{:?}", other) })
  }
});

#[derive(Debug, PartialEq)]
pub struct SavedVariables<'a> {
    pub(crate) recordings: Vec<Recording<'a>>,
}

try_from_struct!(SavedVariables { recordings });

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
    #[error("Unable to parse SavedVariables file. {message}")]
    ParseError { message: String },
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
    let (_, value) = initial_assignment(data).map_err(|err| SavedVariablesError::ParseError {
        message: match err {
            nom::Err::Incomplete(_) => unreachable!(),
            nom::Err::Error(inner) | nom::Err::Failure(inner) => convert_error(data, inner),
        },
    })?;

    SavedVariables::try_from(value)
}

pub fn parse_compressed_recording(data: &str) -> Result<ParsedRecording<'_>, SavedVariablesError> {
    let data = decompress(data).map_err(SavedVariablesError::DecompressionError)?;
    let data = deserialize(&data).map_err(SavedVariablesError::DeserializeError)?;
    match data {
        Value::Table(Table::Named(mut map)) => Ok(ParsedRecording {
            onUpdateDelay: TrackerData::try_from(map.remove("onUpdateDelay").ok_or(
                SavedVariablesError::MissingKey {
                    name: "Recording",
                    key: "onUpdateDelay",
                },
            )?)?,
            scripts: {
                let value = map
                    .remove("scripts")
                    .ok_or(SavedVariablesError::MissingKey {
                        name: "Recording",
                        key: "scripts",
                    })?;

                match value {
                    Value::Table(Table::Named(map)) => map
                        .into_iter()
                        .map(|(k, v)| {
                            Ok::<_, SavedVariablesError>((
                                Cow::Owned(k.to_string()),
                                TrackerData::try_from(v)?,
                            ))
                        })
                        .collect::<Result<HashMap<_, _>, _>>()?,
                    _ => unimplemented!(),
                }
            },
        }),
        _ => unimplemented!(),
    }
}

#[cfg(test)]
mod test {
    use nom::combinator::complete;

    use crate::parser::{decompress, parse_compressed_recording, Recording, RecordingData};

    use super::SavedVariables;

    macro_rules! test_parse {
        ($name:ident, $parser:path, $input:expr) => {
            #[test]
            fn $name() {
                let result = complete($parser)($input);

                match result {
                    Ok(_) => {}
                    Err(nom::Err::Failure(err)) | Err(nom::Err::Error(err)) => {
                        println!("{}", nom::error::convert_error($input, err,));
                        assert!(false);
                    }
                    _ => unreachable!(),
                }
            }
        };
    }

    test_parse!(
        parse_string_key,
        super::named_pair,
        "[\"recordings\"] = 123"
    );
    test_parse!(parse_comment, super::comment, "-- foo\r\n");
    test_parse!(
        parse_encounter_table,
        super::table,
        r#"{
                                ["mapId"] = 1571,
                                ["success"] = true,
                                ["endTime"] = 1681777809,
                                ["kind"] = "mythicplus",
                                ["startTime"] = 1681776154,
                                ["groupSize"] = 5,
                        }"#
    );

    test_parse!(
        parse_samples_table,
        super::table,
        r#"{
                   0.003000000026077032, -- [1]
                   0.005000000353902578, -- [2]
                   0.006000000052154064, -- [3]
                   0.005000000353902578, -- [4]
                   0.005000000353902578, -- [5]
                   0.00800000037997961, -- [6]
                   0.005000000353902578, -- [7]
                   0.006000000052154064, -- [8]
                   0.007000000216066837, -- [9]
              }"#
    );

    test_parse!(
        parse_nested_tables,
        super::table_array,
        "{ 'abcd', 0, {{}}}"
    );
    test_parse!(parse_single_string, super::value, "'abcd'");

    test_parse!(parse_string_bad_escape, super::value, r#""ab\d\"""#);

    #[test]
    fn parse_table_comment() {
        let (_, value) = complete(super::table_empty)(
            r#"{ -- foo
                                                             }"#,
        )
        .unwrap();

        assert_eq!(value, super::Table::Empty);
    }

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

        assert!(result.is_ok());

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
}
