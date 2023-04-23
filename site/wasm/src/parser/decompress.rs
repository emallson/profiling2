use std::io::prelude::*;

use flate2::write::DeflateDecoder;

const PRINT_DECODING_TABLE: &[u8] = &[
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 62, 63, 0, 0, 0, 0, 0, 0, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 0, 0,
    0, 0, 0, 0, 0, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
    46, 47, 48, 49, 50, 51, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
];

/// code 97 is ACTUALLY 0
const SPECIAL_ZERO: u8 = 97;

const fn decode_byte(b: u8) -> Result<u8, DecompressionError> {
    if b == SPECIAL_ZERO {
        Ok(0)
    } else {
        match PRINT_DECODING_TABLE[b as usize] {
            0 => Err(DecompressionError::InvalidPrintByte(b)),
            other => Ok(other),
        }
    }
}

#[derive(thiserror::Error, Debug)]
pub enum DecompressionError {
    #[error("Found invalid byte during print decoding {0}")]
    InvalidPrintByte(u8),
    #[error("Unable to decode with DEFLATE: {0}")]
    DeflateError(std::io::Error),
}

/// Port of LibDeflate:DecodeForPrint
///
/// Outputs a vector of bytes.
pub(super) fn decode_for_print(input: &str) -> Result<Vec<u8>, DecompressionError> {
    let mut result = Vec::new();
    let bytes = input.as_bytes();
    let (major, minor) = bytes.split_at(bytes.len() - 4);
    assert!(major.len() % 4 == 0);
    for x in major.chunks(4) {
        let mut cache: usize = decode_byte(x[0])? as usize
            + decode_byte(x[1])? as usize * 64
            + decode_byte(x[2])? as usize * 4096
            + decode_byte(x[3])? as usize * 262144;
        let b1 = cache % 256;
        cache = (cache - b1) / 256;
        let b2 = cache % 256;
        let b3 = (cache - b2) / 256;
        result.push(b1 as u8);
        result.push(b2 as u8);
        result.push(b3 as u8);
    }

    let mut cache = 0;
    let mut cache_bitlen = 0;
    for &b in minor {
        cache += decode_byte(b)? as u64 * 2u64.pow(cache_bitlen);
        cache_bitlen += 6;
    }

    while cache_bitlen >= 8 {
        let b = cache % 256;
        result.push(b as u8);
        cache = (cache - b) / 256;
        cache_bitlen -= 8;
    }

    Ok(result)
}

pub fn decompress(input: &str) -> Result<Vec<u8>, DecompressionError> {
    let decoded = decode_for_print(input)?;

    let mut buffer = Vec::new();
    let mut deflater = DeflateDecoder::new(buffer);
    deflater
        .write_all(&decoded[..])
        .map_err(DecompressionError::DeflateError)?;
    buffer = deflater
        .finish()
        .map_err(DecompressionError::DeflateError)?;

    Ok(buffer)
}
