// LemonLime: compare tokens within each line, ignoring extra spaces and tabs.
// Adapted from Testlib-for-Lemons ce95947b/checkers/lcmp.cpp (MIT; ../LICENSE).
#include "lemon/testlib.h"
#include <sstream>
#include <vector>
std::vector<std::string> words(const std::string& line) {
    std::istringstream stream(line);
    std::vector<std::string> result;
    for (std::string word; stream >> word;) result.push_back(word);
    return result;
}
int main(int argc, char* argv[]) {
    registerLemonChecker(argc, argv);
    int count = 0;
    while (!ans.eof()) {
        std::string expected = ans.readString();
        if (expected.empty() && ans.eof()) break;
        std::string actual = ouf.readString();
        if (words(expected) != words(actual)) quitf(_wa, "Line %d differs", count + 1);
        ++count;
    }
    quitf(_ok, "%d lines", count);
}
