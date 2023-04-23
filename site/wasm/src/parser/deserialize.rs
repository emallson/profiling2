use std::collections::HashMap;

use bitvec::prelude::*;
use bitvec_nom::BSlice;
use nom::{
    branch::alt,
    bytes::complete::{tag, take},
    combinator::{map, map_res, value, verify},
    multi::{fold_many_m_n, many_m_n},
    sequence::{pair, preceded, tuple},
};
use num_derive::FromPrimitive;
use num_traits::cast::FromPrimitive;

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

#[derive(Debug, Clone, PartialEq)]
enum Object {
    MedInt(i16),
    UShort(u8),
    Array(Vec<Object>),
    String(String),
    Table(HashMap<String, Object>),
    MixedTable {
        array: Vec<Object>,
        keyed: HashMap<String, Object>,
    },
}

/// The S in medint
fn sign_bit(input: Bits) -> IResult<i8> {
    map(take(1u8), |b: Bits| if b[0] { -1 } else { 1 })(input)
}

/// Format: LLLL S100 HHHH HHHH
fn deserialize_medint(input: Bits) -> IResult<Object> {
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

            Object::MedInt(result.load::<i16>() * (sign as i16))
        },
    )(input)
}

/// Format: NNNN NNN1
fn deserialize_ushort(input: Bits) -> IResult<Object> {
    map(preceded(tag(BSlice(bits![1])), take(7u8)), |bits: Bits| {
        Object::UShort(bits.load::<u8>())
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
    count: u8,
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
fn string(count: u8) -> impl FnMut(Bits) -> IResult<String> {
    // TODO: AddReference calls?
    move |input| {
        map_res(take(count * 8u8), |bits: Bits| {
            let bytes = bits.domain().collect::<Vec<u8>>();
            String::from_utf8(bytes)
        })(input)
    }
}

/// Read `count` objects into an array.
fn array(entry_count: u8) -> impl FnMut(Bits) -> IResult<Vec<Object>> {
    move |input| many_m_n(entry_count.into(), entry_count.into(), any_object)(input)
}

/// Read `count` keys from a table into a hashmap.
fn table(entry_count: u8) -> impl FnMut(Bits) -> IResult<HashMap<String, Object>> {
    move |input| {
        fold_many_m_n(
            entry_count.into(),
            entry_count.into(),
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
fn destructure_mixed_counts(c: u8) -> (u8, u8) {
    (c % 4 + 1, c / 4 + 1)
}

/// Mixed table (array and keyed parts). `count` is actually bits, but I realized late and haven't
/// gone back to fix it yet. FIXME
fn mixed_table(mixed_counts: u8) -> impl FnMut(Bits) -> IResult<Object> {
    let (array_count, keyed_count) = destructure_mixed_counts(mixed_counts);
    move |input| {
        map(
            tuple((array(array_count), table(keyed_count))),
            |(array, keyed)| Object::MixedTable { array, keyed },
        )(input)
    }
}

fn deserialize_small_object(input: Bits) -> IResult<Object> {
    let (rest, SmallObjectHeader { count, type_tag }) = small_object_header(input)?;

    match type_tag {
        SmallObjectType::String => map(string(count), Object::String)(rest),
        SmallObjectType::Array => map(array(count), Object::Array)(rest),
        SmallObjectType::Table => map(table(count), Object::Table)(rest),
        SmallObjectType::Mixed => mixed_table(count)(rest),
    }
}

#[derive(Debug)]
struct LargeObjectHeader {
    type_tag: u8,
}

/// Format: TTTT T000
fn large_object_header(input: Bits) -> IResult<LargeObjectHeader> {
    map(
        preceded(tag(BSlice(bits![0, 0, 0])), take(5u8)),
        |tag: Bits| LargeObjectHeader {
            type_tag: tag.load(),
        },
    )(input)
}

fn any_object(input: Bits) -> IResult<Object> {
    alt((
        deserialize_small_object,
        deserialize_medint,
        deserialize_ushort,
        // deserialize_largeobj,
    ))(input)
}

fn deserialize(input: Bits) -> IResult<Object> {
    preceded(version_byte, any_object)(input)
}

#[cfg(test)]
mod test {
    use bitvec::prelude::*;
    use bitvec_nom::BSlice;

    use crate::parser::deserialize::Object;

    #[test]
    fn test_deserialize_int() {
        let data = [0x01, 0x24, 0x4d];
        let (_, result) = super::deserialize(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Object::MedInt(1234));
    }

    #[test]
    fn test_deserialize_negative_int() {
        let data = [0x01, 0x7c, 0x1a];
        let (_, result) = super::deserialize(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Object::MedInt(-423));
    }

    #[test]
    fn test_deserialize_short() {
        let data = [0x01, 0x0b];
        let (_, result) = super::deserialize(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Object::UShort(5));
    }

    #[test]
    fn test_deserialize_string() {
        let data = [0x01, 0x32, 0x66, 0x6f, 0x6f];
        let (_, result) = super::deserialize(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(result, Object::String("foo".into()),);
    }

    #[test]
    fn test_deserialize_array() {
        let data = [0x01, 0x3a, 0x03, 0x32, 0x66, 0x6f, 0x6f, 0x07];
        let (_, result) = super::deserialize(BSlice(data.view_bits::<Lsb0>())).unwrap();
        assert_eq!(
            result,
            Object::Array(vec![
                Object::UShort(1),
                Object::String("foo".into()),
                Object::UShort(3),
            ])
        );
    }
}
