#include <stdio.h>
#include <string.h>

/* __HELPER_TEMPLATE__ */

/* Application declarations deliberately named AgentValue and adbg_str, matching
   the generic global names the migration removed. The lightweight helper keeps
   every symbol behind an agent_debug_ prefix, so these application symbols are
   untouched and the file compiles — proving the inserted helper introduces no
   conflicting names and that its includes and declarations sit legally before
   existing application code. */
struct AgentValue {
    const char *label;
    long long counts[2];
};

static const char *adbg_str(const char *text) {
    return text;
}

static long long agent_value_total(const struct AgentValue *value) {
    return value->counts[0] + value->counts[1];
}

int main(void) {
    struct AgentValue value;
    value.label = adbg_str("inner-module");
    value.counts[0] = 3;
    value.counts[1] = 1;
    /* __CALL_TEMPLATE__ */
    printf("application-completed: %s %lld\n", value.label, agent_value_total(&value));
    return 0;
}
