// LemonLime: compare tokens, ignoring whitespace.
// Adapted from Testlib-for-Lemons ce95947b/checkers/wcmp.cpp (MIT; ../LICENSE).
#include "lemon/testlib.h"
int main(int argc, char* argv[]) {
    registerLemonChecker(argc, argv);
    int count = 0;
    while (!ans.seekEof() && !ouf.seekEof()) {
        std::string expected = ans.readWord(), actual = ouf.readWord();
        if (expected != actual) quitf(_wa, "Token %d differs", count + 1);
        ++count;
    }
    if (!ans.seekEof() || !ouf.seekEof()) quitf(_wa, "Different number of tokens");
    quitf(_ok, "%d tokens", count);
}
