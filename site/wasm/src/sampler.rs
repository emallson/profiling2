use crate::parser::TrackerData;
use js_sys::Float64Array;

fn uniform_sample<T: Copy>(data: &[T]) -> T {
    data[fastrand::usize(..data.len())]
}

fn sample_sum(data: &Vec<&TrackerData>, weights: &[f32]) -> f64 {
    let mut result = 0f64;
    for i in 0..data.len() {
        let w = fastrand::f32();
        if w <= weights[i] {
            result += uniform_sample(&data[i].stats.samples);
        }
    }
    // this truncates 0 by guaranteeing that at least one always activates
    let always_on = fastrand::f32();
    let mut accum = 0f32;

    for i in 0..data.len() {
        accum += weights[i];
        if always_on <= accum {
            return uniform_sample(&data[i].stats.samples);
        }
    }

    result
}

pub fn sample_join(data: Vec<&TrackerData>, size: u32) -> Float64Array {
    let array = Float64Array::new_with_length(size);
    let mut total_weight = 0f32;
    let mut weights = Vec::with_capacity(data.len());

    for datum in &data {
        total_weight += datum.commits as f32;
    }

    for i in 0..data.len() {
        weights[i] = data[i].commits as f32 / total_weight;
    }

    for i in 0..size {
        array.set_index(i, sample_sum(&data, &weights));
    }

    array
}
