use std::{
    borrow::Cow,
    collections::HashMap,
    fmt::{Debug, Display},
};

use bitvec::{macros::internal::funty::Integral, prelude::*};
use bitvec_nom::BSlice;
use nom::{
    branch::alt,
    bytes::complete::{tag, take},
    combinator::{complete, flat_map, map, map_opt, map_res, value, verify},
    multi::{fold_many_m_n, many_m_n},
    number::complete::f64,
    sequence::{pair, preceded, tuple},
    Offset,
};
use num_derive::FromPrimitive;
use num_traits::cast::FromPrimitive;

use super::{Table, Value};

const DESERIALIZATION_VERSION: u8 = 2;

type Bits<'a> = BSlice<'a, u8, Lsb0>;

type IResult<'a, O> = nom::IResult<Bits<'a>, O, nom::error::Error<Bits<'a>>>;

fn version_byte(input: Bits) -> IResult<bool> {
    value(
        true,
        verify(take(8u8), |b: &Bits| {
            b.load::<u8>() <= DESERIALIZATION_VERSION
        }),
    )(input)
}

/// The S in medint
fn sign_bit(input: Bits) -> IResult<i8> {
    map(take(1u8), |b: Bits| if b[0] { -1 } else { 1 })(input)
}

/// Format: LLLL S100 HHHH HHHH
fn deserialize_medint(input: Bits) -> IResult<Value> {
    map(
        preceded(
            tag(BSlice(bits![0, 0, 1])),
            tuple((sign_bit, take(4u8), take(8u8))),
        ),
        |(sign, low, high)| {
            let result = bits![mut u8, Lsb0; 0; 16];
            result[4..12] |= &*high;
            result[0..4] |= &*low;

            println!("{} {} {}", result, &*high, &*low);

            Value::Int((result.load::<i16>() * (sign as i16)).into())
        },
    )(input)
}

/// Format: NNNN NNN1
fn deserialize_ushort(input: Bits) -> IResult<Value> {
    map(preceded(tag(BSlice(bits![1])), take(7u8)), |bits: Bits| {
        Value::Int(bits.load::<i64>())
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
fn small_object_header(input: Bits) -> IResult<SmallObjectHeader> {
    map(
        preceded(tag(BSlice(bits![0, 1])), tuple((take(2u8), take(4u8)))),
        |(type_tag, count): (Bits, Bits)| SmallObjectHeader {
            count: count.load(),
            type_tag: SmallObjectType::from_u8(type_tag.load()).unwrap(),
        },
    )(input)
}

/// Read a `count`-byte string. This assumes things are already aligned correctly.
///
/// Unfortunately, this makes a copy. Could be zero copy but types are hard.
fn string(count: u32) -> impl FnMut(Bits) -> IResult<Cow<str>> {
    // TODO: AddReference calls?
    move |input| {
        map_res(take(count as u8 * 8u8), |bits: Bits| {
            let bytes = bits.domain().collect::<Vec<u8>>();
            String::from_utf8(bytes).map(Cow::Owned)
        })(input)
    }
}

/// Read `count` objects into an array.
fn array(entry_count: u32) -> impl FnMut(Bits) -> IResult<Vec<Value>> {
    move |input| many_m_n(entry_count as usize, entry_count as usize, any_object)(input)
}

/// Read `count` keys from a table into a hashmap.
fn table(entry_count: u32) -> impl FnMut(Bits) -> IResult<HashMap<Cow<str>, Value>> {
    move |input| {
        fold_many_m_n(
            entry_count as usize,
            entry_count as usize,
            pair(string(1), any_object),
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
fn mixed_table(mixed_counts: u32) -> impl FnMut(Bits) -> IResult<Value> {
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

fn deserialize_small_object(input: Bits) -> IResult<Value> {
    let (rest, SmallObjectHeader { count, type_tag }) = small_object_header(input)?;

    match type_tag {
        SmallObjectType::String => map(string(count), Value::String)(rest),
        SmallObjectType::Array => {
            map(array(count), |array| Value::Table(Table::Array(array)))(rest)
        }
        SmallObjectType::Table => map(table(count), |map| Value::Table(Table::Named(map)))(rest),
        SmallObjectType::Mixed => mixed_table(count)(rest),
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
            Str8 | Table8 | Array8 | Mixed8 | StringRef8 | TableRef8 | FloatStrPos
            | FloatStrNeg => 1,
            Str16 | Table16 | Array16 | Mixed16 | StringRef16 | TableRef16 | I16Pos | I16Neg => 2,
            Str24 | Table24 | Array24 | Mixed24 | StringRef24 | TableRef24 | I24Pos | I24Neg => 3,
            I32Pos | I32Neg => 4,
            // ???? taken straight from the LibSerialize source?!?!
            I64Pos | I64Neg => 7,
            Float => 8,
            Nil | BoolTrue | BoolFalse => 0,
        }
    }
}

/// Format: TTTT T000
fn large_object_header(input: Bits) -> IResult<LargeObjectHeader> {
    map_opt(
        preceded(tag(BSlice(bits![0, 0, 0])), take(5u8)),
        |tag: Bits| LargeObjectHeader::from_u8(tag.load()),
    )(input)
}

fn int<T: Integral>(bytes: u8) -> impl FnMut(Bits) -> IResult<T> {
    move |input| map(take(bytes * 8u8), |bits: Bits| bits.load::<T>())(input)
}

fn bytes(count: u8) -> impl FnMut(Bits) -> IResult<Vec<u8>> {
    move |input| {
        map(take(count * 8u8), |bits: Bits| {
            bits.domain().collect::<Vec<u8>>()
        })(input)
    }
}

fn float(input: Bits) -> IResult<f64> {
    map_res(bytes(8), |b| {
        let (_, res) = complete(f64::<_, nom::error::Error<&[u8]>>(
            nom::number::Endianness::Big,
        ))(b.as_slice())
        .expect("parsing to succeed fingers crossed");
        Ok::<f64, nom::error::Error<&Bits>>(res)
    })(input)
}

fn deserialize_large_object(input: Bits) -> IResult<Value> {
    let (rest, header) = large_object_header(input)?;

    use LargeObjectHeader::*;
    match header {
        Nil => Ok((rest, Value::Nil)),
        BoolTrue => Ok((rest, Value::Bool(true))),
        BoolFalse => Ok((rest, Value::Bool(false))),
        val @ (I16Pos | I24Pos | I32Pos | I64Pos) => map(int(val.bytes()), Value::Int)(input),
        val @ (I16Neg | I24Neg | I32Neg | I64Neg) => {
            map(int(val.bytes()), |v: i64| Value::Int(-v))(input)
        }
        val @ (Str8 | Str16 | Str24) => {
            map(flat_map(int(val.bytes()), string), Value::String)(input)
        }
        val @ (Table8 | Table16 | Table24) => map(flat_map(int(val.bytes()), table), |map| {
            Value::Table(Table::Named(map))
        })(input),
        val @ (Array8 | Array16 | Array24) => map(flat_map(int(val.bytes()), array), |arr| {
            Value::Table(Table::Array(arr))
        })(input),
        val @ (Mixed8 | Mixed16 | Mixed24) => flat_map(int(val.bytes()), mixed_table)(input),
        Float => map(float, Value::Float)(input),
        FloatStrPos => unimplemented!(),
        FloatStrNeg => unimplemented!(),
        StringRef8 | StringRef16 | StringRef24 | TableRef8 | TableRef16 | TableRef24 => {
            unimplemented!("refs are not implemented yet")
        }
    }
}

fn any_object(input: Bits) -> IResult<Value> {
    alt((
        deserialize_large_object,
        deserialize_small_object,
        deserialize_medint,
        deserialize_ushort,
    ))(input)
}

fn deserialize_internal(input: Bits) -> IResult<Value> {
    preceded(version_byte, any_object)(input)
}

#[derive(Debug)]
pub struct SerializeParseError {
    kind: nom::error::ErrorKind,
    offset: usize,
}

impl Display for SerializeParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_fmt(format_args!("{:?} (offset: {})", self.kind, self.offset))?;

        Ok(())
    }
}

pub fn deserialize<'a: 'b, 'b>(input: &'a Vec<u8>) -> Result<Value<'b>, SerializeParseError> {
    let slice = BSlice(input.view_bits::<Lsb0>());
    match deserialize_internal(slice) {
        Err(err) => match err {
            nom::Err::Incomplete(_) => {
                unreachable!("cannot reach this point due to complete combinator")
            }
            nom::Err::Failure(err) | nom::Err::Error(err) => Err(SerializeParseError {
                kind: err.code,
                offset: err.input.offset(&slice),
            }),
        },
        Ok((_, value)) => Ok(value),
    }
}

#[cfg(test)]
mod test {
    use std::borrow::Cow;

    use bitvec::prelude::*;
    use bitvec_nom::BSlice;

    use crate::parser::{Table, Value};

    #[test]
    fn test_deserialize_int() {
        let data = [0x01, 0x24, 0x4d];
        let (_, result) = super::deserialize_internal(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Value::Int(1234));
    }

    #[test]
    fn test_deserialize_negative_int() {
        let data = [0x01, 0x7c, 0x1a];
        let (_, result) = super::deserialize_internal(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Value::Int(-423));
    }

    #[test]
    fn test_deserialize_short() {
        let data = [0x01, 0x0b];
        let (_, result) = super::deserialize_internal(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Value::Int(5));
    }

    #[test]
    fn test_deserialize_string() {
        let data = [0x01, 0x32, 0x66, 0x6f, 0x6f];
        let (_, result) = super::deserialize_internal(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Value::String(Cow::Borrowed("foo")),);
    }

    #[test]
    fn test_deserialize_array() {
        let data = [0x01, 0x3a, 0x03, 0x32, 0x66, 0x6f, 0x6f, 0x07];
        let (_, result) = super::deserialize_internal(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(
            result,
            Value::Table(Table::Array(vec![
                Value::Int(1),
                Value::String(Cow::Borrowed("foo")),
                Value::Int(3),
            ]))
        );
    }
}
