#include "testlib.h"

int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int n = inf.readInt(1, 100'000, "n");
    inf.readEoln();
    for (int i = 0; i < n; i++) {
        inf.readInt(1, 1'000'000'000, "a_i");
        if (i + 1 < n) inf.readSpace();
    }
    inf.readEoln();
    inf.readEof();
}
