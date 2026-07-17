use jaq_core::load::{Arena, File, Loader};
use jaq_core::{data, unwrap_valr, Ctx, Vars};
use jaq_json::{read, Val};
use napi::bindgen_prelude::Result;
use napi_derive::napi;

fn query_error(message: impl std::fmt::Debug) -> napi::Error {
    napi::Error::from_reason(format!("{message:?}"))
}

#[napi]
pub fn run_jaq(program: String, input_json: String) -> Result<String> {
    let input = read::parse_single(input_json.as_bytes()).map_err(query_error)?;
    let program = File {
        code: program.as_str(),
        path: (),
    };
    let defs = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs());
    let funs = jaq_core::funs()
        .chain(jaq_std::funs())
        .chain(jaq_json::funs());
    let loader = Loader::new(defs);
    let arena = Arena::default();
    let modules = loader.load(&arena, program).map_err(query_error)?;
    let filter = jaq_core::Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(query_error)?;
    let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
    let values = filter
        .id
        .run((ctx, input))
        .map(unwrap_valr)
        .map(|result| result.map(|value| value.to_string()).map_err(query_error))
        .collect::<Result<Vec<_>>>()?;

    Ok(format!("[{}]", values.join(",")))
}
