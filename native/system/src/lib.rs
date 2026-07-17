use napi_derive::napi;
use serde_json::Value;
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, Signal, System};

fn system_for_pid(pid: Pid) -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::everything(),
    );
    system
}

#[napi(object)]
pub struct ProcessInspection {
    pub exists: bool,
    pub executable: Option<String>,
    pub pid: u32,
    pub start_time: Option<f64>,
    pub zombie: bool,
}

#[napi(object)]
pub struct TerminationResult {
    pub reason: String,
    pub terminated: bool,
}

#[napi]
pub fn inspect_process(pid: u32) -> ProcessInspection {
    let pid_value = Pid::from_u32(pid);
    let system = system_for_pid(pid_value);
    match system.process(pid_value) {
        Some(process) => ProcessInspection {
            exists: true,
            executable: process
                .exe()
                .map(|path| path.to_string_lossy().into_owned()),
            pid,
            start_time: Some(process.start_time() as f64),
            zombie: matches!(process.status(), ProcessStatus::Zombie),
        },
        None => ProcessInspection {
            exists: false,
            executable: None,
            pid,
            start_time: None,
            zombie: false,
        },
    }
}

#[napi]
pub fn terminate_if_identity_matches(
    pid: u32,
    identity: String,
    force: Option<bool>,
) -> TerminationResult {
    let expected = match serde_json::from_str::<Value>(&identity) {
        Ok(expected) => expected,
        Err(_) => {
            return TerminationResult {
                reason: "invalid-identity".to_owned(),
                terminated: false,
            };
        }
    };
    let pid_value = Pid::from_u32(pid);
    let system = system_for_pid(pid_value);
    let Some(process) = system.process(pid_value) else {
        return TerminationResult {
            reason: "process-absent".to_owned(),
            terminated: false,
        };
    };
    if !identity_matches(process, &expected) {
        return TerminationResult {
            reason: "identity-mismatch".to_owned(),
            terminated: false,
        };
    }
    if matches!(process.status(), ProcessStatus::Zombie) {
        return TerminationResult {
            reason: "process-zombie".to_owned(),
            terminated: false,
        };
    }

    let terminated = if force.unwrap_or(false) {
        process.kill()
    } else {
        process
            .kill_with(Signal::Term)
            .unwrap_or_else(|| process.kill())
    };
    TerminationResult {
        reason: if terminated {
            "signal-sent".to_owned()
        } else {
            "signal-failed".to_owned()
        },
        terminated,
    }
}

fn identity_matches(process: &Process, expected: &Value) -> bool {
    let expected_start = expected.get("startTime").and_then(Value::as_f64);
    let expected_executable = expected.get("executable").and_then(Value::as_str);
    let actual_executable = process.exe().map(|path| path.to_string_lossy());

    expected_start == Some(process.start_time() as f64)
        && expected_executable.is_some()
        && expected_executable == actual_executable.as_deref()
}

#[cfg(test)]
mod tests {
    use super::terminate_if_identity_matches;

    #[test]
    fn refuses_to_signal_a_process_when_identity_does_not_match() {
        let result = terminate_if_identity_matches(
            std::process::id(),
            r#"{"startTime":0,"executable":"/definitely/not/the/current/process"}"#.to_owned(),
            Some(true),
        );

        assert!(!result.terminated);
        assert_eq!(result.reason, "identity-mismatch");
    }
}
