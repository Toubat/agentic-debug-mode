use std::collections::HashMap;

__HELPER_TEMPLATE__

// An application type deliberately named AgentValue, plus nested modules, to
// prove the inserted helper introduces no conflicting global symbols and sits
// legally at module scope alongside existing items.
#[derive(Debug)]
struct AgentValue {
    label: String,
    counts: HashMap<String, i64>,
}

mod domain {
    pub mod inner {
        pub fn describe() -> &'static str {
            "inner-module"
        }
    }
}

impl AgentValue {
    fn total(&self) -> i64 {
        self.counts.values().copied().sum()
    }
}

fn main() {
    let mut counts = HashMap::new();
    counts.insert("hits".to_string(), 3i64);
    counts.insert("misses".to_string(), 1i64);
    let value = AgentValue {
        label: domain::inner::describe().to_string(),
        counts,
    };
    __CALL_TEMPLATE__
    println!("application-completed: {} {}", value.label, value.total());
}
