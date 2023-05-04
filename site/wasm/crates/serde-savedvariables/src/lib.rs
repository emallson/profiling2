use std::{borrow::Cow, collections::HashMap};

use nom::{
    branch::alt,
    bytes::complete::{escaped, tag, take_while1},
    character::complete::{i64 as parse_i64, line_ending, multispace1, none_of, one_of},
    combinator::{complete, eof, map, not, opt, recognize},
    error::VerboseError,
    multi::{fold_many0, many0, separated_list1},
    number::complete::double,
    sequence::{delimited, separated_pair, terminated},
};

use serde::{
    de::{
        self,
        value::{MapDeserializer, SeqDeserializer},
        IntoDeserializer, Visitor,
    },
    forward_to_deserialize_any, Deserialize,
};

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
    FloatArray(Vec<f64>),
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
            _ => unreachable!("non-string table key found from string parser?!"),
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

pub fn from_str<'a, T>(s: &'a str) -> Result<T, ParseError>
where
    T: Deserialize<'a>,
{
    let (_, value) = alt((initial_assignment, complete(value)))(s)
        .map_err(|v| ParseError::ValueError(format!("{}", v)))?;
    let deserializer = ValueDeserializer(value);
    let t = T::deserialize(deserializer)?;

    Ok(t)
}

#[derive(thiserror::Error, Debug)]
pub enum ParseError {
    #[error("an unknown parse error has occurred")]
    Unknown,
    #[error("An error occurred during deserialization: {0}")]
    SerdeCustom(String),
    #[error("A parse error occurred: {0}")]
    ValueError(String),
    #[error("Parsing tables with mixed array and named parts is unsupported.")]
    MixedTable,
}

impl de::Error for ParseError {
    fn custom<T>(msg: T) -> Self
    where
        T: std::fmt::Display,
    {
        ParseError::SerdeCustom(msg.to_string())
    }
}

pub struct ValueDeserializer<'a>(Value<'a>);

impl<'de, 'a> IntoDeserializer<'de, ParseError> for Value<'a> {
    type Deserializer = ValueDeserializer<'a>;

    fn into_deserializer(self) -> Self::Deserializer {
        ValueDeserializer(self)
    }
}

impl<'de, 'a> de::Deserializer<'de> for ValueDeserializer<'a> {
    type Error = ParseError;

    fn deserialize_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.0 {
            Value::Nil => visitor.visit_unit(),
            Value::Int(v) => visitor.visit_i64(v),
            Value::Bool(v) => visitor.visit_bool(v),
            Value::Float(v) => visitor.visit_f64(v),
            Value::String(Cow::Owned(v)) => visitor.visit_string(v),
            Value::String(Cow::Borrowed(v)) => visitor.visit_str(v),
            Value::Table(Table::Empty) => {
                visitor.visit_seq(SeqDeserializer::new(std::iter::empty::<Value<'a>>()))
            }
            Value::Table(Table::Array(vec)) => {
                visitor.visit_seq(SeqDeserializer::new(vec.into_iter()))
            }
            Value::Table(Table::Named(map)) => {
                visitor.visit_map(MapDeserializer::new(map.into_iter()))
            }
            Value::Table(Table::FloatArray(vec)) => {
                visitor.visit_seq(SeqDeserializer::new(vec.into_iter()))
            }
            Value::Table(Table::MixedTable { .. }) => Err(ParseError::MixedTable),
        }
    }

    fn deserialize_option<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.0 {
            Value::Nil => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_newtype_struct<V>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        visitor.visit_newtype_struct(self)
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct seq tuple
        tuple_struct map struct enum identifier ignored_any
    }
}

#[cfg(test)]
mod test {
    use pretty_assertions::assert_eq;
    #[test]
    fn deserialize_string() {
        let str: String = super::from_str(r#"'foo'"#).unwrap();
        assert_eq!(str, "foo");
    }

    #[test]
    fn deserialize_option() {
        let opt: Option<usize> = super::from_str("nil").unwrap();
        assert_eq!(opt, None);

        let opt: Option<usize> = super::from_str("1234").unwrap();
        assert_eq!(opt, Some(1234));
    }

    #[test]
    fn deserialize_float() {
        let f: f64 = super::from_str("-1.342").unwrap();

        assert_eq!(f, -1.342);
    }

    #[test]
    fn deserialize_newtype() {
        #[derive(serde::Deserialize, PartialEq, Eq, Debug)]
        struct Test(usize);
        let test: Test = super::from_str(r#"1234"#).unwrap();

        assert_eq!(test, Test(1234));
    }

    #[test]
    fn deserialize_unit() {
        let unit: () = super::from_str("nil").unwrap();
        assert_eq!(unit, ());
    }

    #[test]
    fn deserialize_tuple() {
        let tup: (f64, String) = super::from_str("{1.234,'foo'}").unwrap();
        assert_eq!(tup, (1.234, "foo".to_string()));
    }

    #[test]
    fn deserialize_struct() {
        #[derive(serde::Deserialize, Debug, PartialEq)]
        struct Test {
            foo: String,
            bar: f64,
            baz: bool,
        }

        let test: Test = super::from_str(r#"{ foo = "xyz", bar = 12.345, baz = false }"#).unwrap();

        assert_eq!(
            test,
            Test {
                foo: "xyz".to_string(),
                bar: 12.345,
                baz: false,
            }
        );
    }

    #[test]
    fn deserialize_enum() {
        #[derive(serde::Deserialize, Debug, PartialEq)]
        #[serde(untagged)]
        enum Test {
            Empty,
            Float(f64),
            Array { value: Vec<usize> },
        }

        let result: Vec<Test> =
            super::from_str(r#"{nil, 0.1234, { value = {0, 1, 2, 3}}}"#).unwrap();
        assert_eq!(
            result,
            vec![
                Test::Empty,
                Test::Float(0.1234),
                Test::Array {
                    value: vec![0, 1, 2, 3]
                }
            ]
        )
    }

    use nom::combinator::complete;

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
}
