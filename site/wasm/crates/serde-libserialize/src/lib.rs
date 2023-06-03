/// Support for decoding data serialized with LibSerialize in World of Warcraft.
///
/// Saved, serialized data is not UTF-8 (or ASCII) safe, and so it is typically compressed & encoded
/// with LibDeflate. Support for decoding this is enabled by the `libdeflate` feature, which is
/// enabled by default.
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::HashMap,
    fmt::{Debug, Display},
    ops::RangeFrom,
    rc::Rc,
};

use bitvec::{macros::internal::funty::Integral, prelude::*};

use nom::{
    branch::alt,
    bytes::complete::take,
    combinator::{complete, cut, flat_map, map, map_opt, map_res, value, verify},
    error::{context, ErrorKind, FromExternalError, VerboseError},
    multi::{fold_many_m_n, many_m_n},
    number::{self, complete::be_f64},
    sequence::{pair, preceded, tuple},
    InputIter, InputLength, InputTake, Offset, Parser, Slice,
};
use num_derive::FromPrimitive;
use num_traits::cast::FromPrimitive;

use serde_savedvariables::{Table, Value};

#[cfg(feature = "libdeflate")]
pub mod deflate;

const DESERIALIZATION_VERSION: u8 = 2;

type Bytes<'a> = &'a [u8];
type Byte = BitArray<u8, Lsb0>;

#[derive(Clone, Debug)]
struct ValueRefTable<T> {
    by_index: Vec<T>,
    // value table seems intended for serialization, shouldn't need for deser
    // by_value: HashMap<T, usize>,
}

#[derive(Clone, Debug)]
struct State<'a> {
    string_refs: RefCell<ValueRefTable<Cow<'a, str>>>,
    table_refs: RefCell<ValueRefTable<Table<'a>>>,
}

impl<'a> State<'a> {
    fn new<'b>() -> State<'b> {
        State {
            string_refs: RefCell::new(ValueRefTable { by_index: vec![] }),
            table_refs: RefCell::new(ValueRefTable { by_index: vec![] }),
        }
    }

    fn add_str_ref(&self, value: Cow<'a, str>) {
        self.string_refs.borrow_mut().by_index.push(value);
    }
    fn add_table_ref(&self, value: Table<'a>) {
        self.table_refs.borrow_mut().by_index.push(value);
    }

    fn get_str_ref(&self, key: usize) -> Option<Cow<'a, str>> {
        self.string_refs.borrow().by_index.get(key - 1).cloned()
    }

    fn get_table_ref(&self, key: usize) -> Option<Table<'a>> {
        self.table_refs.borrow().by_index.get(key - 1).cloned()
    }
}

#[derive(Clone, Debug)]
struct ParserState<'a> {
    input: Bytes<'a>,
    state: Rc<State<'a>>,
}

impl<'a> ParserState<'a> {
    fn new(input: Bytes<'_>) -> ParserState<'_> {
        ParserState {
            input,
            state: Rc::new(State::new()),
        }
    }
}

impl<'a> InputIter for ParserState<'a> {
    type Item = u8;

    type Iter = <Bytes<'a> as InputIter>::Iter;
    type IterElem = <Bytes<'a> as InputIter>::IterElem;

    fn iter_indices(&self) -> Self::Iter {
        self.input.iter_indices()
    }

    fn iter_elements(&self) -> Self::IterElem {
        self.input.iter_elements()
    }

    fn position<P>(&self, predicate: P) -> Option<usize>
    where
        P: Fn(Self::Item) -> bool,
    {
        self.input.position(predicate)
    }

    fn slice_index(&self, count: usize) -> Result<usize, nom::Needed> {
        self.input.slice_index(count)
    }
}

impl<'a> Offset for ParserState<'a> {
    fn offset(&self, second: &Self) -> usize {
        self.input.offset(second.input)
    }
}

impl<'a> InputTake for ParserState<'a> {
    fn take(&self, count: usize) -> Self {
        ParserState {
            input: self.input.take(count),
            state: self.state.clone(),
        }
    }

    fn take_split(&self, count: usize) -> (Self, Self) {
        let (left, right) = self.input.take_split(count);

        (
            ParserState {
                input: left,
                state: self.state.clone(),
            },
            ParserState {
                input: right,
                state: self.state.clone(),
            },
        )
    }
}

impl<'a> InputLength for ParserState<'a> {
    fn input_len(&self) -> usize {
        self.input.input_len()
    }
}

impl<'a> Slice<RangeFrom<usize>> for ParserState<'a> {
    fn slice(&self, range: RangeFrom<usize>) -> Self {
        ParserState {
            input: self.input.slice(range),
            state: self.state.clone(),
        }
    }
}

type IResult<'a, O> = nom::IResult<ParserState<'a>, O, nom::error::VerboseError<ParserState<'a>>>;

fn byte(input: ParserState) -> IResult<BitArray<u8, Lsb0>> {
    map(take::<u8, _, _>(1u8), |bytes: ParserState| {
        BitArray::<u8, Lsb0>::from(bytes.input[0])
    })(input)
}

fn version_byte(input: ParserState) -> IResult<bool> {
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
) -> impl FnMut(ParserState<'a>) -> IResult<'a, Byte> {
    move |input| verify(byte, |byte: &Byte| byte[0..len] == type_tag[0..len])(input)
}

/// Format: LLLL S100 HHHH HHHH
fn deserialize_medint(input: ParserState) -> IResult<Value> {
    map(
        tuple((tagged_byte(bitarr![const u8, Lsb0; 0, 0, 1], 3), byte)),
        |(low, high)| {
            let result = bits![mut u8, Lsb0; 0; 16];
            result[4..12] |= high;
            result[0..4] |= &low[4..8];

            let sign = if low[3] { -1 } else { 1 };

            Value::Int((result.load::<u16>() as i16 * (sign as i16)).into())
        },
    )(input)
}

/// Format: NNNN NNN1
fn deserialize_ushort(input: ParserState) -> IResult<Value> {
    map(tagged_byte(bitarr![const u8, Lsb0; 1], 1), |bits| {
        Value::Int(bits[1..].load::<u8>() as i64)
    })(input)
}

/// Format: AAKK
fn mixed_count(input: u32) -> (u32, u32) {
    let bits = BitArray::<u8, Lsb0>::from(input as u8);

    (bits[2..=3].load::<u32>(), bits[0..=1].load::<u32>())
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
fn small_object_header(input: ParserState) -> IResult<SmallObjectHeader> {
    map(
        tagged_byte(bitarr![const u8, Lsb0; 0, 1], 2),
        |byte: Byte| SmallObjectHeader {
            count: byte[4..8].load(),
            type_tag: SmallObjectType::from_u8(byte[2..4].load()).unwrap(),
        },
    )(input)
}

/// Read a `count`-byte string. This assumes things are already aligned correctly.
fn string(count: u32) -> impl FnMut(ParserState) -> IResult<Cow<str>> {
    // TODO: AddReference calls?
    move |input| {
        map_res(take(count), |bytes: ParserState| {
            core::str::from_utf8(bytes.input).map(Cow::Borrowed)
        })(input)
    }
}

/// Read `count` objects into an array.
fn array(entry_count: u32) -> impl FnMut(ParserState) -> IResult<Vec<Value>> {
    move |input| many_m_n(entry_count as usize, entry_count as usize, any_object)(input)
}

fn float_array(entry_count: u32) -> impl FnMut(ParserState) -> IResult<Value> {
    move |input| {
        fold_many_m_n(
            entry_count as usize,
            entry_count as usize,
            deserialize_float,
            || Vec::with_capacity(entry_count as usize),
            |mut vec, value| {
                vec.push(value);
                vec
            },
        )
        .map(|v| Value::Table(Table::FloatArray(v)))
        .parse(input)
    }
}

/// Read `count` keys from a table into a hashmap.
fn table(entry_count: u32) -> impl FnMut(ParserState) -> IResult<HashMap<Cow<str>, Value>> {
    move |input| {
        let res = fold_many_m_n(
            entry_count as usize,
            entry_count as usize,
            pair(
                context(
                    "found table in key location in non-array table",
                    map_res(any_object, |v| match v {
                        Value::String(s) => Ok(s),
                        Value::Int(v) => Ok(Cow::Owned(v.to_string())),
                        Value::Float(v) => Ok(Cow::Owned(v.to_string())),
                        Value::Bool(b) => Ok(Cow::Owned(b.to_string())),
                        Value::Nil => Ok(Cow::Borrowed("nil")),
                        Value::Table(_actual) => Err("found table in table key location"),
                    }),
                ),
                any_object,
            ),
            HashMap::new,
            |mut map, (k, v)| {
                map.insert(k, v);
                map
            },
        )(input);

        return res;
    }
}

/// Mixed table (array and keyed parts). `count` is actually bits, but I realized late and haven't
/// gone back to fix it yet. FIXME
fn mixed_table(
    (array_count, keyed_count): (u32, u32),
) -> impl FnMut(ParserState) -> IResult<Value> {
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

fn store_table_ref<'a>(
    mut parser: impl FnMut(ParserState<'a>) -> IResult<Value<'a>>,
) -> impl FnMut(ParserState<'a>) -> IResult<Value<'a>> {
    move |input| {
        let (output, result) = parser(input)?;
        if let Value::Table(table) = &result {
            output.state.add_table_ref(table.clone());
        }
        Ok((output, result))
    }
}

fn table_ref(key: usize) -> impl FnMut(ParserState) -> IResult<Value> {
    move |input| match input.state.get_table_ref(key) {
        None => Err(nom::Err::Failure(VerboseError::from_external_error(
            input,
            ErrorKind::MapOpt,
            DeserializationError::MissingRef(key),
        ))),
        Some(table) => Ok((input, Value::Table(table.clone()))),
    }
}

fn store_string_ref<'a>(
    mut parser: impl FnMut(ParserState<'a>) -> IResult<Value<'a>>,
) -> impl FnMut(ParserState<'a>) -> IResult<Value<'a>> {
    move |input| {
        let (output, result) = parser(input)?;
        if let Value::String(result) = &result {
            output.state.add_str_ref(result.clone());
        }
        Ok((output, result))
    }
}

fn string_ref(key: usize) -> impl FnMut(ParserState) -> IResult<Value> {
    move |input| match input.state.get_str_ref(key) {
        None => Err(nom::Err::Failure(VerboseError::from_external_error(
            input,
            ErrorKind::MapOpt,
            DeserializationError::MissingRef(key),
        ))),
        Some(string) => Ok((input, Value::String(string.clone()))),
    }
}

fn deserialize_small_object(input: ParserState) -> IResult<Value> {
    let (rest, SmallObjectHeader { count, type_tag }) = small_object_header(input)?;

    match type_tag {
        SmallObjectType::String => store_string_ref(cut(map(string(count), Value::String)))(rest),
        SmallObjectType::Array => store_table_ref(cut(alt((
            float_array(count),
            map(array(count), |array| Value::Table(Table::Array(array))),
        ))))(rest),
        SmallObjectType::Table => store_table_ref(cut(map(table(count), |map| {
            Value::Table(Table::Named(map))
        })))(rest),
        SmallObjectType::Mixed => store_table_ref(cut(mixed_table(mixed_count(count))))(rest),
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

            Mixed8 => 1,
            Mixed16 => 2,
            Mixed24 => 3,
        }
    }
}

/// Format: TTTT T000
fn large_object_header(input: ParserState) -> IResult<LargeObjectHeader> {
    map_opt(tagged_byte(bitarr![const u8, Lsb0; 0, 0, 0], 3), |tag| {
        LargeObjectHeader::from_u8(tag[3..8].load())
    })(input)
}

fn int<'a, T: Integral + FromPrimitive + 'a>(
    bytes: u8,
) -> impl FnMut(ParserState<'a>) -> IResult<'a, T> {
    match bytes {
        1 => move |input| map_opt(number::complete::be_u8, FromPrimitive::from_u8)(input),
        2 => move |input| map_opt(number::complete::be_u16, FromPrimitive::from_u16)(input),
        3 => move |input| map_opt(number::complete::be_u24, FromPrimitive::from_u32)(input),
        4 => move |input| map_opt(number::complete::be_u32, FromPrimitive::from_u32)(input),
        8 => move |input| map_opt(number::complete::be_u64, FromPrimitive::from_u64)(input),
        other => unimplemented!("{} is not a supported integer size", other),
    }
}

fn float(input: ParserState) -> IResult<f64> {
    be_f64(input)
}

fn float_str(count: u8) -> impl FnMut(ParserState) -> IResult<f64> {
    move |input| {
        map_res(take(count), |bytes: ParserState| {
            core::str::from_utf8(bytes.input)
                .map_err(|_err| DeserializationError::Utf8Error)?
                .parse::<f64>()
                .map_err(DeserializationError::StrFloatError)
        })(input)
    }
}

// We deal with a lot of float arrays. This fast path helps improve parsing performance of them.
fn deserialize_float(input: ParserState) -> IResult<f64> {
    let (rest, header) = large_object_header(input.clone())?;

    match header {
        LargeObjectHeader::Float => float(rest),
        _ => Err(nom::Err::Error(VerboseError::from_external_error(
            input,
            ErrorKind::Alt,
            (),
        ))),
    }
}

fn deserialize_large_object(input: ParserState) -> IResult<Value> {
    let (rest, header) = large_object_header(input)?;

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
            store_string_ref(cut(map(flat_map(int(val.bytes()), string), Value::String)))(rest)
        }
        val @ (Table8 | Table16 | Table24) => {
            store_table_ref(cut(map(flat_map(int(val.bytes()), table), |map| {
                Value::Table(Table::Named(map))
            })))(rest)
        }
        val @ (Array8 | Array16 | Array24) => store_table_ref(cut(alt((
            flat_map(int(val.bytes()), float_array),
            map(flat_map(int(val.bytes()), array), |arr| {
                Value::Table(Table::Array(arr))
            }),
        ))))(rest),
        val @ (Mixed8 | Mixed16 | Mixed24) => store_table_ref(cut(flat_map(
            tuple((int(val.bytes()), int(val.bytes()))),
            mixed_table,
        )))(rest),
        Float => cut(map(float, Value::Float))(rest),
        val @ FloatStrPos => cut(map(flat_map(int(val.bytes()), float_str), Value::Float))(rest),
        val @ FloatStrNeg => cut(map(flat_map(int(val.bytes()), float_str), |v| {
            Value::Float(-v)
        }))(rest),
        val @ (TableRef8 | TableRef16 | TableRef24) => {
            cut(flat_map(int(val.bytes()), table_ref))(rest)
        }
        val @ (StringRef8 | StringRef16 | StringRef24) => {
            cut(flat_map(int(val.bytes()), string_ref))(rest)
        }
    }
}

fn any_object(input: ParserState) -> IResult<Value> {
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

fn deserialize_internal(input: ParserState) -> IResult<Value> {
    complete(preceded(version_byte, any_object))(input)
}

#[derive(thiserror::Error, Debug)]
pub enum DeserializationError {
    #[error("Unable to decode utf8 string")]
    Utf8Error,
    #[error("Unable to decode string-represented float")]
    StrFloatError(#[from] std::num::ParseFloatError),
    #[error("Reference to missing table or string (key: {0})")]
    MissingRef(usize),
    #[error("Failed to parse serialized data. {0}")]
    GenericParseError(SerializeParseError),
    #[error("Failed to deserialize from SavedVariables format.")]
    SavedVariablesError(#[from] serde_savedvariables::ParseError),
    #[cfg(feature = "libdeflate")]
    #[error("Unable to decompress data. {0}")]
    DecompressionError(#[from] deflate::DecompressionError),
}

#[derive(Debug)]
pub struct SerializeParseError {
    repr: Vec<String>,
}

impl Display for SerializeParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for msg in &self.repr {
            f.write_str(msg)?;
        }
        Ok(())
    }
}

fn deserialize<'a: 'b, 'b>(input: &'a [u8]) -> Result<Value<'b>, SerializeParseError> {
    let state = ParserState::new(input);
    match deserialize_internal(state) {
        Err(err) => match err {
            nom::Err::Incomplete(_) => {
                unreachable!("cannot reach this point due to complete combinator")
            }
            nom::Err::Failure(err) | nom::Err::Error(err) => Err(SerializeParseError {
                repr: err
                    .errors
                    .into_iter()
                    .map(|(inner, kind)| {
                        format!("{:?} in byte {}", kind, input.offset(inner.input))
                    })
                    .collect(),
            }),
        },
        Ok((_, value)) => Ok(value),
    }
}

/// Deserialize data from a LibDeflate string encoded with EncodeForPrint.
#[cfg(feature = "libdeflate")]
pub fn from_str<'de, T: serde::de::Deserialize<'de>>(
    input: &str,
) -> Result<T, DeserializationError> {
    let decompressed = deflate::decompress(input)?;

    from_bytes(&decompressed)
}

/// Deserialize data from a raw byte array. Note that the strings produced by LibSerialize are NOT
/// valid UTF-8 in general and are not guaranteed to be output correctly by the code in WoW that
/// dumps SavedVariables.
///
/// It is strongly encouraged to encode your data after serialization. This method exists to support
/// use cases that do not use LibDeflate to handle the encoding.
pub fn from_bytes<'de, T: serde::de::Deserialize<'de>>(
    input: &[u8],
) -> Result<T, DeserializationError> {
    use serde::de::IntoDeserializer;

    let deserializer = deserialize(input)
        .map_err(DeserializationError::GenericParseError)?
        .into_deserializer();

    Ok(T::deserialize(deserializer)?)
}

#[cfg(test)]
mod test {
    use std::borrow::Cow;

    use map_macro::hash_map;
    use pretty_assertions::assert_eq;

    use super::{Table, Value};

    #[test]
    fn test_deserialize_int() {
        let data = [0x01, 0x24, 0x4d];
        let result = super::deserialize(&data).unwrap();
        assert_eq!(result, Value::Int(1234));
    }

    #[test]
    fn test_deserialize_negative_int() {
        let data = [0x01, 0x7c, 0x1a];
        let result = super::deserialize(&data).unwrap();
        assert_eq!(result, Value::Int(-423));
    }

    #[test]
    fn test_deserialize_short() {
        let data = [0x01, 0x0b];
        let result = super::deserialize(&data).unwrap();
        assert_eq!(result, Value::Int(5));
    }

    #[test]
    fn test_deserialize_string() {
        let data = [0x01, 0x32, 0x66, 0x6f, 0x6f];
        let result = super::deserialize(&data).unwrap();
        assert_eq!(result, Value::String(Cow::Borrowed("foo")),);
    }

    #[test]
    fn test_deserialize_array() {
        let data = [0x01, 0x3a, 0x03, 0x32, 0x66, 0x6f, 0x6f, 0x07];
        let result = super::deserialize(&data).unwrap();
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
        let result = super::deserialize(&data).unwrap();
        assert_eq!(
            result,
            Value::Table(Table::Named(hash_map! {
              Cow::Borrowed("skew") => Value::Float(-0.23456),
              Cow::Borrowed("mean") => Value::Float(0.05001),
              Cow::Borrowed("samples") => Value::Table(Table::Array(vec![Value::Int(1), Value::Int(2), Value::Int(3), Value::Int(4)])),
              Cow::Borrowed("quantiles") => Value::Table(Table::Named(hash_map! {
                Cow::Borrowed("0.5") => Value::Float(0.05),
                Cow::Borrowed("0.75") => Value::Float(0.06),
                Cow::Borrowed("0.95") => Value::Float(0.08),
                Cow::Borrowed("0.99") => Value::Float(0.1),
              }))
            }))
        )
    }
}
