/// Rather than embed a whole lua parser (of which we need very little), use a basic nom parser for the saved variables table
use std::num::TryFromIntError;

pub mod types;

pub use types::*;

#[derive(thiserror::Error, Debug)]
pub enum SavedVariablesError {
    #[error("Unable to parse SavedVariables file. {0}")]
    ParseError(#[from] serde_savedvariables::ParseError),
    #[error("Unable to parse LibSerialize data: {0:?}")]
    DeserializeError(#[from] serde_libserialize::DeserializationError),
    #[error("Unable to cast number from signed to unsigned. {0}")]
    SignCastError(#[from] TryFromIntError),
}

pub fn parse_saved_variables(data: &str) -> Result<SavedVariables<'_>, SavedVariablesError> {
    Ok(serde_savedvariables::from_str(data)?)
}

pub fn parse_compressed_recording(data: &str) -> Result<ParsedRecording<'_>, SavedVariablesError> {
    Ok(serde_libserialize::from_str(data)?)
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
                let decoded = serde_libserialize::deflate::decode_for_print(data)
                    .expect("to decode successfully");
                assert_eq!(decoded.len(), 7404);
                let decompressed = serde_libserialize::deflate::decompress(data)
                    .expect("to decode + decompress successfully");
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
    fn parse_heiji_may30_data() {
        let result =
            super::parse_saved_variables(include_str!("../../../test-data/test_heiji_may30.lua"));

        assert!(result.is_ok());

        let mut result = result.unwrap();
        assert_eq!(result.recordings.len(), 14);

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
