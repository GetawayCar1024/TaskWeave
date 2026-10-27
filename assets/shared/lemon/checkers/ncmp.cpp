// LemonLime: compare signed 64-bit integer sequences (whitespace independent).
// Adapted from Testlib-for-Lemons ce95947b/checkers/ncmp.cpp (MIT; ../LICENSE).
#include "lemon/testlib.h"
int main(int argc, char* argv[]) {
    registerLemonChecker(argc, argv);
    int count = 0;
    while (!ans.seekEof() && !ouf.seekEof()) {
        long long expected = ans.readLong(), actual = ouf.readLong();
        if (expected != actual) quitf(_wa, "Number %d: expected %s, found %s", count + 1, vtos(expected).c_str(), vtos(actual).c_str());
        ++count;
    }
    if (!ans.seekEof() || !ouf.seekEof()) quitf(_wa, "Different number of integers");
    quitf(_ok, "%d integers", count);
}
