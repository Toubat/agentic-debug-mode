use napi_derive::napi;

#[napi(object)]
pub struct ProcessInspection {
    pub exists: bool,
    pub pid: u32,
}

#[napi(object)]
pub struct TerminationResult {
    pub reason: String,
    pub terminated: bool,
}

#[napi]
pub fn inspect_process(pid: u32) -> ProcessInspection {
    ProcessInspection {
        exists: pid == std::process::id(),
        pid,
    }
}

#[napi]
pub fn terminate_if_identity_matches(_pid: u32, _identity: String) -> TerminationResult {
    TerminationResult {
        reason: "not-implemented".to_owned(),
        terminated: false,
    }
}
