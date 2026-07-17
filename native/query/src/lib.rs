use jaq_core::load::{Arena, File, Loader};
use jaq_core::{Ctx, Vars, data, unwrap_valr};
use jaq_json::{Val, read};
use napi::bindgen_prelude::Result;
use napi_derive::napi;
use std::fs::File as FsFile;
use std::io::{BufRead, BufReader};
use std::rc::Rc;

fn query_error(message: impl std::fmt::Debug) -> napi::Error {
    napi::Error::from_reason(format!("{message:?}"))
}

fn execute(program: &str, inputs: Vec<Val>, slurp: bool) -> Result<String> {
    let source = File {
        code: program,
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
    let modules = loader.load(&arena, source).map_err(query_error)?;
    let filter = jaq_core::Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(query_error)?;
    let inputs = if slurp {
        vec![Val::Arr(Rc::new(inputs))]
    } else {
        inputs
    };
    let mut values = Vec::new();
    for input in inputs {
        let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
        values.extend(
            filter
                .id
                .run((ctx, input))
                .map(unwrap_valr)
                .map(|result| result.map(|value| value.to_string()).map_err(query_error))
                .collect::<Result<Vec<_>>>()?,
        );
    }

    Ok(format!("[{}]", values.join(",")))
}

#[napi]
pub fn run_jaq(program: String, input_json: String) -> Result<String> {
    let input = read::parse_single(input_json.as_bytes()).map_err(query_error)?;
    execute(&program, vec![input], false)
}

#[napi]
pub fn run_jaq_batch(program: String, inputs_json: String, slurp: bool) -> Result<String> {
    let input = read::parse_single(inputs_json.as_bytes()).map_err(query_error)?;
    let Val::Arr(inputs) = input else {
        return Err(napi::Error::from_reason(
            "Batch query input must be a JSON array".to_owned(),
        ));
    };
    execute(&program, inputs.as_ref().clone(), slurp)
}

#[napi]
pub fn run_jaq_file(
    program: String,
    path: String,
    run_id: String,
    hypotheses_json: String,
    watermark: f64,
    slurp: bool,
) -> Result<String> {
    let hypotheses: Vec<String> = serde_json::from_str(&hypotheses_json).map_err(query_error)?;
    let source = File {
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
    let modules = loader.load(&arena, source).map_err(query_error)?;
    let filter = jaq_core::Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(query_error)?;
    let file = FsFile::open(path).map_err(query_error)?;
    let reader = BufReader::new(file);
    let mut inputs = Vec::new();
    let mut values = Vec::new();
    let mut total_records = 0_u64;
    let mut scanned_records = 0_u64;

    for line in reader.lines() {
        let line = line.map_err(query_error)?;
        if line.is_empty() {
            continue;
        }
        let scope: serde_json::Value = serde_json::from_str(&line).map_err(query_error)?;
        let matches_run =
            scope.get("runId").and_then(serde_json::Value::as_str) == Some(run_id.as_str());
        let hypothesis = scope
            .get("hypothesisId")
            .and_then(serde_json::Value::as_str);
        let sequence = scope
            .get("sequence")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(f64::INFINITY);
        let matches_hypothesis = hypotheses.is_empty()
            || hypothesis.is_some_and(|id| hypotheses.iter().any(|h| h == id));
        if !matches_run || sequence > watermark {
            continue;
        }
        total_records += 1;
        if !matches_hypothesis {
            continue;
        }
        scanned_records += 1;
        let input = read::parse_single(line.as_bytes()).map_err(query_error)?;
        if slurp {
            inputs.push(input);
            continue;
        }
        let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
        values.extend(
            filter
                .id
                .run((ctx, input))
                .map(unwrap_valr)
                .map(|result| result.map(|value| value.to_string()).map_err(query_error))
                .collect::<Result<Vec<_>>>()?,
        );
    }

    if slurp {
        let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
        values.extend(
            filter
                .id
                .run((ctx, Val::Arr(Rc::new(inputs))))
                .map(unwrap_valr)
                .map(|result| result.map(|value| value.to_string()).map_err(query_error))
                .collect::<Result<Vec<_>>>()?,
        );
    }
    Ok(format!(
        "{{\"results\":[{}],\"scannedRecords\":{scanned_records},\"totalRecords\":{total_records}}}",
        values.join(",")
    ))
}

#[cfg(test)]
mod tests {
    use super::{run_jaq_batch, run_jaq_file};
    use std::fs;

    #[test]
    fn compiles_once_for_streaming_inputs() {
        let output = run_jaq_batch(
            "select(.data.index > 1) | .id".to_owned(),
            r#"[{"id":"a","data":{"index":1}},{"id":"b","data":{"index":2}}]"#.to_owned(),
            false,
        )
        .unwrap();

        assert_eq!(output, r#"["b"]"#);
    }

    #[test]
    fn slurps_inputs_into_one_array() {
        let output = run_jaq_batch(
            "sort_by(.timestamp) | map(.id)".to_owned(),
            r#"[{"id":"b","timestamp":2},{"id":"a","timestamp":1}]"#.to_owned(),
            true,
        )
        .unwrap();

        assert_eq!(output, r#"[["a","b"]]"#);
    }

    #[test]
    fn supports_regex_grouping_and_fixed_schema_fields() {
        let regex = run_jaq_batch(
            r#"select(.message | test("time.*out"; "i")) | [.location, .hypothesisId]"#.to_owned(),
            r#"[{"message":"Timed OUT","location":"a.ts:1","hypothesisId":"H1"}]"#.to_owned(),
            false,
        )
        .unwrap();
        let grouped = run_jaq_batch(
            "group_by(.hypothesisId) | map({hypothesisId: .[0].hypothesisId, count: length})"
                .to_owned(),
            r#"[{"hypothesisId":"H1"},{"hypothesisId":"H2"},{"hypothesisId":"H1"}]"#.to_owned(),
            true,
        )
        .unwrap();

        assert_eq!(regex, r#"[["a.ts:1","H1"]]"#);
        assert_eq!(
            grouped,
            r#"[[{"hypothesisId":"H1","count":2},{"hypothesisId":"H2","count":1}]]"#
        );
    }

    #[test]
    fn rejects_invalid_programs() {
        assert!(run_jaq_batch("select(".to_owned(), "[]".to_owned(), false).is_err());
    }

    #[test]
    fn streams_only_the_requested_file_scope() {
        let path = std::env::temp_dir().join(format!(
            "agentic-debug-mode-query-{}.ndjson",
            std::process::id()
        ));
        fs::write(
            &path,
            concat!(
                "{\"id\":\"a\",\"runId\":\"baseline\",\"hypothesisId\":\"H1\",\"sequence\":1}\n",
                "{\"id\":\"b\",\"runId\":\"other\",\"hypothesisId\":\"H1\",\"sequence\":2}\n",
                "{\"id\":\"c\",\"runId\":\"baseline\",\"hypothesisId\":\"H2\",\"sequence\":3}\n"
            ),
        )
        .unwrap();

        let output = run_jaq_file(
            ".id".to_owned(),
            path.to_string_lossy().into_owned(),
            "baseline".to_owned(),
            r#"["H1"]"#.to_owned(),
            2.0,
            false,
        )
        .unwrap();
        fs::remove_file(path).unwrap();

        assert_eq!(
            output,
            r#"{"results":["a"],"scannedRecords":1,"totalRecords":1}"#
        );
    }
}
