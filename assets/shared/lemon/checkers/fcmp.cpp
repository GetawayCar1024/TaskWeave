// LemonLime: compare lines, preserving spaces within lines.
// Adapted from Testlib-for-Lemons ce95947b/checkers/fcmp.cpp (MIT; ../LICENSE).
#include "lemon/testlib.h"
int main(int argc, char* argv[]) {
    registerLemonChecker(argc, argv);
    int count = 0;
    while (!ans.eof()) {
        std::string expected = ans.readString();
        if (expected.empty() && ans.eof()) break;
        if (expected != ouf.readString()) quitf(_wa, "Line %d differs", count + 1);
        ++count;
    }
    quitf(_ok, "%d lines", count);
}
