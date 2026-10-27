# Testlib for Lemons

Vendored without modifications from https://github.com/GitPinkRabbit/Testlib-for-Lemons
at commit ce95947b3894572e6664c8906bf8768d26c7a77e. See LICENSE and the notices in testlib.h.

LemonLime references this project for its Lemon special judge protocol.
Taskweave keeps it separate from the ordinary shared/testlib.h.

```cpp
#include "lemon/testlib.h"
int main(int argc, char* argv[]) {
    registerLemonChecker(argc, argv);
    long long expected = ans.readLong();
    long long actual = ouf.readLong();
    if (actual != expected) quitf(_wa, "Expected %lld, got %lld", expected, actual);
    quitf(_ok, "Accepted");
}
```

Configure this source as `lemon_checker`, separately from the ordinary checker.
Lemon calls it with: input, contestant output, answer, full score, score file, message file.
For proportional partial credit with this library, set `quitpRelativeScoring = true` before calling `quitp`.

## Taskweave checker templates

`checkers/` contains MIT-licensed adaptations of the upstream checkers at the pinned
commit above: ncmp (int64), wcmp (tokens), lcmp (tokens within lines), fcmp (lines),
rcmp6 (absolute/relative 1e-6), and yesno. The adapters use `lemon/testlib.h` and
`registerLemonChecker`, and can be selected as `lemon:ncmp`, etc. in `lemon_checker`.
Copy a template into the problem to customize it. They use Lemon's six-argument
score/report-file protocol, independently of ordinary Polygon checkers.
