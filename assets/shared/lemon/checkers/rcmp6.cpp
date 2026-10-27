// LemonLime: floating-point sequences, absolute or relative tolerance 1e-6.
// Adapted from Testlib-for-Lemons ce95947b/checkers/rcmp6.cpp (MIT; ../LICENSE).
#include "lemon/testlib.h"
const double EPS = 1e-6;
int main(int argc, char* argv[]) {
    registerLemonChecker(argc, argv);
    int count = 0;
    while (!ans.seekEof()) {
        double expected = ans.readDouble(), actual = ouf.readDouble();
        if (!doubleCompare(expected, actual, EPS)) quitf(_wa, "Number %d differs: expected %.12g, found %.12g", count + 1, expected, actual);
        ++count;
    }
    quitf(_ok, "%d real numbers", count);
}
