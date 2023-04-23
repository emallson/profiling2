use std::{
    any::type_name,
    borrow::Cow,
    collections::HashMap,
    fmt::{Debug, Display},
};

use bitvec::{macros::internal::funty::Integral, prelude::*};
use bitvec_nom::BSlice;
use nom::{
    branch::alt,
    bytes::complete::{tag, take},
    combinator::{complete, cut, flat_map, map, map_opt, map_res, value, verify},
    error::context,
    multi::{fold_many_m_n, many_m_n},
    number::{self, complete::be_f64},
    sequence::{pair, preceded, tuple},
    Offset,
};
use num_derive::FromPrimitive;
use num_traits::cast::FromPrimitive;

use super::{Table, Value};

const DESERIALIZATION_VERSION: u8 = 2;

type Bytes<'a> = &'a [u8];
type Byte = BitArray<u8, Lsb0>;

type IResult<'a, O> = nom::IResult<Bytes<'a>, O, nom::error::VerboseError<Bytes<'a>>>;

fn byte(input: Bytes) -> IResult<BitArray<u8, Lsb0>> {
    map(take::<u8, Bytes, _>(1u8), |bytes| {
        BitArray::<u8, Lsb0>::from(bytes[0])
    })(input)
}

fn version_byte(input: Bytes) -> IResult<bool> {
    value(
        true,
        verify(byte, |b: &BitArray<u8, Lsb0>| {
            b.load::<u8>() <= DESERIALIZATION_VERSION
        }),
    )(input)
}

/// Succeeds if the next byte matches the given tag, returning the byte.
fn tagged_byte<'a>(
    type_tag: BitArray<[u8; 1], Lsb0>,
    len: usize,
) -> impl FnMut(Bytes<'a>) -> IResult<'a, Byte> {
    move |input| verify(byte, |byte: &Byte| byte[0..len] == type_tag[0..len])(input)
}

/// Format: LLLL S100 HHHH HHHH
fn deserialize_medint(input: Bytes) -> IResult<Value> {
    map(
        tuple((tagged_byte(bitarr![const u8, Lsb0; 0, 0, 1], 3), byte)),
        |(low, high)| {
            let result = bits![mut u8, Lsb0; 0; 16];
            result[4..12] |= high;
            result[0..4] |= &low[4..8];

            println!("{} {} {}", result, &*high, &*low);

            let sign = if low[3] { -1 } else { 1 };

            Value::Int((result.load::<u16>() as i16 * (sign as i16)).into())
        },
    )(input)
}

/// Format: NNNN NNN1
fn deserialize_ushort(input: Bytes) -> IResult<Value> {
    map(tagged_byte(bitarr![const u8, Lsb0; 1], 1), |bits| {
        Value::Int(bits[1..].load::<u8>() as i64)
    })(input)
}

#[derive(Debug, FromPrimitive)]
enum SmallObjectType {
    String = 0,
    Table = 1,
    Array = 2,
    Mixed = 3,
}

#[derive(Debug)]
struct SmallObjectHeader {
    count: u32,
    type_tag: SmallObjectType,
}

/// Format: CCCC TT10
fn small_object_header(input: Bytes) -> IResult<SmallObjectHeader> {
    map(
        tagged_byte(bitarr![const u8, Lsb0; 0, 1], 2),
        |byte: Byte| SmallObjectHeader {
            count: byte[4..8].load(),
            type_tag: SmallObjectType::from_u8(byte[2..4].load()).unwrap(),
        },
    )(input)
}

/// Read a `count`-byte string. This assumes things are already aligned correctly.
fn string(count: u32) -> impl FnMut(Bytes) -> IResult<Cow<str>> {
    // TODO: AddReference calls?
    move |input| {
        map_res(take(count), |bytes: Bytes| {
            core::str::from_utf8(bytes).map(Cow::Borrowed)
        })(input)
    }
}

/// Read `count` objects into an array.
fn array(entry_count: u32) -> impl FnMut(Bytes) -> IResult<Vec<Value>> {
    move |input| many_m_n(entry_count as usize, entry_count as usize, any_object)(input)
}

/// Read `count` keys from a table into a hashmap.
fn table(entry_count: u32) -> impl FnMut(Bytes) -> IResult<HashMap<Cow<str>, Value>> {
    move |input| {
        fold_many_m_n(
            entry_count as usize,
            entry_count as usize,
            pair(
                context(
                    "found non-string key in non-array table",
                    map_res(any_object, |v| match v {
                        Value::String(s) => Ok(s),
                        actual => {
                            println!("actual {:?}", actual);
                            Err(())
                        }
                    }),
                ),
                any_object,
            ),
            HashMap::new,
            |mut map, (k, v)| {
                map.insert(k, v);
                map
            },
        )(input)
    }
}

// ugh
fn destructure_mixed_counts(c: u32) -> (u32, u32) {
    (c % 4 + 1, c / 4 + 1)
}

/// Mixed table (array and keyed parts). `count` is actually bits, but I realized late and haven't
/// gone back to fix it yet. FIXME
fn mixed_table(mixed_counts: u32) -> impl FnMut(Bytes) -> IResult<Value> {
    let (array_count, keyed_count) = destructure_mixed_counts(mixed_counts);
    move |input| {
        map(
            tuple((array(array_count), table(keyed_count))),
            |(array, keyed)| {
                Value::Table(Table::MixedTable {
                    array,
                    named: keyed,
                })
            },
        )(input)
    }
}

fn deserialize_small_object(input: Bytes) -> IResult<Value> {
    let (rest, SmallObjectHeader { count, type_tag }) = small_object_header(input)?;
    println!("small {:?} ({})", type_tag, count);

    match type_tag {
        SmallObjectType::String => trace(cut(map(string(count), Value::String)))(rest),
        SmallObjectType::Array => {
            cut(map(array(count), |array| Value::Table(Table::Array(array))))(rest)
        }
        SmallObjectType::Table => trace(cut(map(table(count), |map| {
            Value::Table(Table::Named(map))
        })))(rest),
        SmallObjectType::Mixed => cut(mixed_table(count))(rest),
    }
}

#[derive(Debug, FromPrimitive)]
enum LargeObjectHeader {
    Nil = 0,
    I16Pos = 1,
    I16Neg = 2,
    I24Pos = 3,
    I24Neg = 4,
    I32Pos = 5,
    I32Neg = 6,
    I64Pos = 7,
    I64Neg = 8,
    Float = 9,
    FloatStrPos = 10,
    FloatStrNeg = 11,

    BoolTrue = 12,
    BoolFalse = 13,

    Str8 = 14,
    Str16 = 15,
    Str24 = 16,

    Table8 = 17,
    Table16 = 18,
    Table24 = 19,

    Array8 = 20,
    Array16 = 21,
    Array24 = 22,

    Mixed8 = 23,
    Mixed16 = 24,
    Mixed24 = 25,

    StringRef8 = 26,
    StringRef16 = 27,
    StringRef24 = 28,
    TableRef8 = 29,
    TableRef16 = 30,
    TableRef24 = 31,
}

impl LargeObjectHeader {
    fn bytes(&self) -> u8 {
        use LargeObjectHeader::*;
        match self {
            Str8 | Table8 | Array8 | StringRef8 | TableRef8 | FloatStrPos | FloatStrNeg => 1,
            Str16 | Table16 | Array16 | StringRef16 | TableRef16 | I16Pos | I16Neg => 2,
            Str24 | Table24 | Array24 | StringRef24 | TableRef24 | I24Pos | I24Neg => 3,
            I32Pos | I32Neg => 4,
            // ???? taken straight from the LibSerialize source?!?!
            I64Pos | I64Neg => 7,
            Float => 8,
            Nil | BoolTrue | BoolFalse => 0,

            Mixed8 => 2,
            Mixed16 => 4,
            Mixed24 => 6,
        }
    }
}

/// Format: TTTT T000
fn large_object_header(input: Bytes) -> IResult<LargeObjectHeader> {
    map_opt(tagged_byte(bitarr![const u8, Lsb0; 0, 0, 0], 3), |tag| {
        LargeObjectHeader::from_u8(tag[3..8].load())
    })(input)
}

fn int<'a, T: Integral + FromPrimitive + 'a>(bytes: u8) -> impl FnMut(Bytes<'a>) -> IResult<'a, T> {
    match bytes {
        1 => move |input| map_opt(number::complete::be_u8, FromPrimitive::from_u8)(input),
        2 => move |input| map_opt(number::complete::be_u16, FromPrimitive::from_u16)(input),
        3 => move |input| map_opt(number::complete::be_u24, FromPrimitive::from_u32)(input),
        4 => move |input| map_opt(number::complete::be_u32, FromPrimitive::from_u32)(input),
        8 => move |input| map_opt(number::complete::be_u64, FromPrimitive::from_u64)(input),
        other => unimplemented!("{} is not a supported integer size", other),
    }
}

// TODO: this is broken and probably the most important one
fn float(input: Bytes) -> IResult<f64> {
    be_f64(input)
}

fn trace<'a, O: Debug>(
    mut inner: impl FnMut(Bytes<'a>) -> IResult<'a, O>,
) -> impl FnMut(Bytes<'a>) -> IResult<'a, O> {
    move |input| {
        let (rest, res) = inner(input)?;
        println!("{:?}", res);
        Ok((rest, res))
    }
}

fn deserialize_large_object(input: Bytes) -> IResult<Value> {
    let (rest, header) = large_object_header(input)?;

    println!("large {:?}", header);

    use LargeObjectHeader::*;
    match header {
        Nil => Ok((rest, Value::Nil)),
        BoolTrue => Ok((rest, Value::Bool(true))),
        BoolFalse => Ok((rest, Value::Bool(false))),
        val @ (I16Pos | I24Pos | I32Pos | I64Pos) => cut(map(int(val.bytes()), Value::Int))(rest),
        val @ (I16Neg | I24Neg | I32Neg | I64Neg) => {
            cut(map(int(val.bytes()), |v: i64| Value::Int(-v)))(rest)
        }
        val @ (Str8 | Str16 | Str24) => {
            cut(map(flat_map(int(val.bytes()), string), Value::String))(rest)
        }
        val @ (Table8 | Table16 | Table24) => cut(map(flat_map(int(val.bytes()), table), |map| {
            Value::Table(Table::Named(map))
        }))(rest),
        val @ (Array8 | Array16 | Array24) => cut(map(flat_map(int(val.bytes()), array), |arr| {
            Value::Table(Table::Array(arr))
        }))(rest),
        val @ (Mixed8 | Mixed16 | Mixed24) => cut(flat_map(int(val.bytes()), mixed_table))(rest),
        Float => trace(cut(map(float, Value::Float)))(rest),
        FloatStrPos => unimplemented!(),
        FloatStrNeg => unimplemented!(),
        StringRef8 | StringRef16 | StringRef24 | TableRef8 | TableRef16 | TableRef24 => {
            unimplemented!("refs are not implemented yet")
        }
    }
}

fn any_object(input: Bytes) -> IResult<Value> {
    context(
        "no object type matched",
        alt((
            context("parsing packed u7", deserialize_ushort),
            context("parsing packed u12", deserialize_medint),
            context("parsing small object", deserialize_small_object),
            context("parsing large object", deserialize_large_object),
        )),
    )(input)
}

fn deserialize_internal(input: Bytes) -> IResult<Value> {
    preceded(version_byte, any_object)(input)
}

#[derive(Debug)]
pub struct SerializeParseError {
    repr: Vec<String>,
}

pub fn deserialize<'a: 'b, 'b>(input: &'a Vec<u8>) -> Result<Value<'b>, SerializeParseError> {
    match deserialize_internal(input) {
        Err(err) => match err {
            nom::Err::Incomplete(_) => {
                unreachable!("cannot reach this point due to complete combinator")
            }
            nom::Err::Failure(err) | nom::Err::Error(err) => Err(SerializeParseError {
                repr: err
                    .errors
                    .into_iter()
                    .map(|(input, kind)| format!("{:?} in byte {}", kind, input.offset(&input) / 8))
                    .collect(),
            }),
        },
        Ok((_, value)) => Ok(value),
    }
}

#[cfg(test)]
mod test {
    use std::{borrow::Cow, collections::HashMap};

    use bitvec::prelude::*;

    use crate::parser::{Table, Value};

    #[test]
    fn test_deserialize_int() {
        let data = [0x01, 0x24, 0x4d];
        let (_, result) = super::deserialize_internal(&data).unwrap();
        assert_eq!(result, Value::Int(1234));
    }

    #[test]
    fn test_deserialize_negative_int() {
        let data = [0x01, 0x7c, 0x1a];
        let (_, result) = super::deserialize_internal(&data).unwrap();
        assert_eq!(result, Value::Int(-423));
    }

    #[test]
    fn test_deserialize_short() {
        let data = [0x01, 0x0b];
        let (_, result) = super::deserialize_internal(&data).unwrap();
        assert_eq!(result, Value::Int(5));
    }

    #[test]
    fn test_deserialize_string() {
        let data = [0x01, 0x32, 0x66, 0x6f, 0x6f];
        let (_, result) = super::deserialize_internal(&data).unwrap();
        assert_eq!(result, Value::String(Cow::Borrowed("foo")),);
    }

    #[test]
    fn test_deserialize_array() {
        let data = [0x01, 0x3a, 0x03, 0x32, 0x66, 0x6f, 0x6f, 0x07];
        let (_, result) = super::deserialize_internal(&data).unwrap();
        assert_eq!(
            result,
            Value::Table(Table::Array(vec![
                Value::Int(1),
                Value::String(Cow::Borrowed("foo")),
                Value::Int(3),
            ]))
        );
    }

    #[test]
    fn test_deserialize_keyed_nested_table() {
        let data = [
            0x1, 0x46, 0x42, 0x73, 0x6b, 0x65, 0x77, 0x48, 0xbf, 0xce, 0x6, 0xf, 0xe4, 0x79, 0x91,
            0xbc, 0x72, 0x73, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x73, 0x4a, 0x3, 0x5, 0x7, 0x9, 0x42,
            0x6d, 0x65, 0x61, 0x6e, 0x48, 0x3f, 0xa9, 0x9a, 0xe9, 0x24, 0xf2, 0x27, 0xd0, 0x92,
            0x71, 0x75, 0x61, 0x6e, 0x74, 0x69, 0x6c, 0x65, 0x73, 0x46, 0x32, 0x30, 0x2e, 0x35,
            0x50, 0x4, 0x30, 0x2e, 0x30, 0x35, 0x42, 0x30, 0x2e, 0x39, 0x35, 0x50, 0x4, 0x30, 0x2e,
            0x30, 0x38, 0x42, 0x30, 0x2e, 0x39, 0x39, 0x50, 0x3, 0x30, 0x2e, 0x31, 0x42, 0x30,
            0x2e, 0x37, 0x35, 0x50, 0x4, 0x30, 0x2e, 0x30, 0x36,
        ];
        let (_, result) = super::deserialize_internal(&data).unwrap();
        assert_eq!(result, Value::Table(Table::Named(HashMap::new())))
    }
}
