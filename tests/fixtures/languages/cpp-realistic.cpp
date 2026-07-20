#include <iostream>
#include <string>
#include <unordered_map>

__HELPER_TEMPLATE__

// An application type deliberately named AgentValue, alongside a namespace, to
// prove the inserted helper introduces no conflicting symbols and that its
// includes and declarations sit legally before existing application code. The
// helper keeps its symbols inside the agent_debug_mode namespace, so this global
// AgentValue is untouched.
struct AgentValue {
    std::string label;
    std::unordered_map<std::string, long long> counts;

    long long total() const {
        long long sum = 0;
        for (const auto& entry : counts) {
            sum += entry.second;
        }
        return sum;
    }
};

namespace domain {
namespace inner {
inline std::string describe() {
    return "inner-module";
}
}  // namespace inner
}  // namespace domain

int main() {
    AgentValue value;
    value.label = domain::inner::describe();
    value.counts["hits"] = 3;
    value.counts["misses"] = 1;
    __CALL_TEMPLATE__
    std::cout << "application-completed: " << value.label << " " << value.total() << std::endl;
    return 0;
}
