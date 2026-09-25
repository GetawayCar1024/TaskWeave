#include "testlib.h"
#include <iostream>
using namespace std;

// usage: gen_random <n> <maxA>
int main(int argc, char* argv[]) {
    registerGen(argc, argv, 1);
    int n = opt<int>(1);
    int maxA = opt<int>(2);
    println(n);
    vector<int> a(n);
    for (auto& x : a) x = rnd.next(1, maxA);
    println(a);
}
