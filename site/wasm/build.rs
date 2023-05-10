#[path = "src/parser/types.rs"]
mod types;

use std::fs;

fn main() {
    let schema = schemars::schema_for!(types::Recording);
    fs::create_dir_all("pkg").unwrap();
    fs::write(
        "pkg/schema.json",
        serde_json::to_string_pretty(&schema).unwrap(),
    )
    .unwrap();
}
