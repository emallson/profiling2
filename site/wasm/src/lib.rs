use std::{borrow::Cow, collections::HashMap, rc::Rc, sync::mpsc::channel};

use ouroboros::self_referencing;
use parser::{
    Encounter, ParsedRecording, Recording, SavedVariables, SavedVariablesError, TrackerData,
};
use serde::Serialize;
use wasm_bindgen::{
    prelude::{wasm_bindgen, Closure},
    JsValue,
};

use crate::parser::RecordingData;

mod parser;

#[self_referencing]
struct SavedVariablesRefInner {
    source: String,
    #[borrows(source)]
    #[covariant]
    data: Vec<Rc<Recording<'this>>>,
}

#[wasm_bindgen]
pub struct SavedVariablesRef {
    inner: Rc<SavedVariablesRefInner>,
}

#[wasm_bindgen]
#[self_referencing]
pub struct RecordingRef {
    source: Rc<SavedVariablesRefInner>,
    #[borrows(source)]
    #[covariant]
    data: Rc<Recording<'this>>,
}

#[wasm_bindgen]
impl SavedVariablesRef {
    pub fn length(&self) -> usize {
        self.inner.borrow_data().len()
    }

    pub fn get(&self, index: usize) -> Option<RecordingRef> {
        let builder = RecordingRefTryBuilder {
            source: self.inner.clone(),
            data_builder: |source| {
                source
                    .borrow_data()
                    .get(index)
                    .cloned()
                    .ok_or(format!("no recording at index {}", index))
            },
        };

        builder.try_build().ok()
    }
}

#[wasm_bindgen]
impl RecordingRef {
    #[wasm_bindgen(getter)]
    pub fn encounter(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.borrow_data().encounter)
            .expect("serialization to always succeed")
    }

    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Result<JsValue, String> {
        let data = self.borrow_data();

        match data.data {
            RecordingData::Parsed(ref data) => {
                serde_wasm_bindgen::to_value(data).map_err(|e| e.to_string())
            }
            RecordingData::Unparsed(ref raw) => {
                let data = parser::parse_compressed_recording(raw).map_err(|e| e.to_string())?;
                serde_wasm_bindgen::to_value(&data).map_err(|e| e.to_string())
            }
        }
    }
}

#[wasm_bindgen]
pub fn parse_saved_variables(blob: String) -> Result<SavedVariablesRef, JsValue> {
    let result = SavedVariablesRefInnerTryBuilder {
        source: blob,
        data_builder: |source| {
            Ok(parser::parse_saved_variables(source)?
                .recordings
                .into_iter()
                .map(Rc::new)
                .collect())
        },
    };

    let data = Rc::new(
        result
            .try_build()
            .map_err(|e: SavedVariablesError| format!("{}", e))?,
    );

    Ok(SavedVariablesRef { inner: data })
}
