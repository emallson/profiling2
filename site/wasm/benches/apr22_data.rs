use criterion::{black_box, criterion_group, criterion_main, Criterion};
use profiling2_wasm::parse_saved_variables;

const DATA: &str = include_str!("../../test-data/test_apr22_2023.lua");

fn initial_parse(c: &mut Criterion) {
    c.bench_function("parse_saved_variables", |b| {
        b.iter_batched(
            || DATA.to_string(),
            |value| parse_saved_variables(black_box(value)),
            criterion::BatchSize::SmallInput,
        )
    });
}

fn load_compressed(c: &mut Criterion) {
    c.bench_function("get data", |b| {
        b.iter_batched(
            || {
                parse_saved_variables(DATA.to_string())
                    .unwrap()
                    .get(1)
                    .unwrap()
            },
            |value| {
                black_box(value.parse_data().unwrap());
            },
            criterion::BatchSize::SmallInput,
        )
    });
}

criterion_group!(apr22_data, initial_parse, load_compressed);
criterion_main!(apr22_data);
