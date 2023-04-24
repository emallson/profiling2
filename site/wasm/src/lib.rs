use std::{cell::RefCell, rc::Rc};

use ouroboros::self_referencing;
use parser::{
    ParsedRecording, Recording, SavedVariablesError,
};

use wasm_bindgen::{
    prelude::{wasm_bindgen},
    JsValue,
};

use crate::parser::RecordingData;

mod parser;
mod sampler;

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
    cached_data: RefCell<Option<JsValue>>,
}

#[wasm_bindgen]
impl SavedVariablesRef {
    pub fn length(&self) -> usize {
        self.inner.borrow_data().len()
    }

    pub fn get(&self, index: usize) -> Option<RecordingRef> {
        let builder = RecordingRefTryBuilder {
            source: self.inner.clone(),
            cached_data: RefCell::new(None),
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

impl RecordingRef {
    /// This runs the data parsing without hitting `serde_wasm_bindgen`. used for testing
    pub fn test_parse_data(&self) -> Result<ParsedRecording<'_>, String> {
        let data = self.borrow_data();

        match data.data {
            RecordingData::Parsed(_) => Err("found parsed data".to_string()),
            RecordingData::Unparsed(ref raw) => {
                let data = parser::parse_compressed_recording(raw).map_err(|e| e.to_string())?;
                Ok(data)
            }
        }
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
                if self.borrow_cached_data().borrow().is_some() {
                    Ok(self.borrow_cached_data().borrow().clone().unwrap())
                } else {
                    let data =
                        parser::parse_compressed_recording(raw).map_err(|e| e.to_string())?;
                    let value = serde_wasm_bindgen::to_value(&data).map_err(|e| e.to_string())?;
                    *(self.borrow_cached_data().borrow_mut()) = Some(value.clone());
                    Ok(value)
                }
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
