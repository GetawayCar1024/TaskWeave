// LemonLime: one YES or NO, case insensitive.
// Adapted from Testlib-for-Lemons ce95947b/checkers/yesno.cpp (MIT; ../LICENSE).
#include "lemon/testlib.h"
int main(int argc, char* argv[]) {
    registerLemonChecker(argc, argv);
    std::string expected = upperCase(ans.readWord()), actual = upperCase(ouf.readWord());
    if (expected != "YES" && expected != "NO") quitf(_fail, "Expected answer is not YES or NO");
    if (actual != "YES" && actual != "NO") quitf(_pe, "Output must be YES or NO");
    if (expected != actual) quitf(_wa, "Expected %s, found %s", expected.c_str(), actual.c_str());
    quitf(_ok, "%s", expected.c_str());
}
