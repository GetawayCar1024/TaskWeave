// SPDX-FileCopyrightText: 2011-2018 Project Lemon, Zhipeng Jia
// SPDX-FileCopyrightText: 2018-2019 Project LemonPlus, Dust1404
// SPDX-FileCopyrightText: 2019-2022 Project LemonLime
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted by Taskweave, 2026-10-28: standalone local checker, Qt removed,
// native Unicode file opening, exit-code protocol. Comparison rules come from
// Project-LemonLime/Project_LemonLime@69aa22370706a4f14b394a6e27aa92e7eca4a8f5
// src/core/casejudger.cpp. See LICENSE and README.md alongside this file.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <string>
#include <string_view>
#ifdef _WIN32
#include <windows.h>
#endif

enum Verdict { Accepted = 0, WrongAnswer = 1, PresentationError = 2, FileError = 3, OutputLimit = 4 };
class BufferedStreamReader {
    static const int BUFFER_SIZE = 1 << 18;
    FILE *file;
    char buffer[BUFFER_SIZE], *bufEnd, *bufPos;
    bool isEof = false;
    int lineNumber = 1;
    std::string result;
    char peekChar() {
        if (isEof) return '\0';
        if (bufPos == bufEnd) {
            bufPos = buffer;
            bufEnd = buffer + fread(buffer, 1, BUFFER_SIZE, file);
            if (bufPos == bufEnd) { isEof = true; return '\0'; }
        }
        return *bufPos;
    }
    void tryNextLine() {
        char c = peekChar();
        if (c != '\r' && c != '\n') return;
        if (c == '\r') bufPos++;
        if (peekChar() == '\n') bufPos++;
        lineNumber++;
    }
public:
    explicit BufferedStreamReader(FILE *input) : file(input), bufEnd(buffer + BUFFER_SIZE), bufPos(buffer + BUFFER_SIZE) { result.reserve(32); }
    bool eof() const { return isEof; }
    int line() const { return lineNumber; }
    std::string_view nextUntilNewLine() {
        result.clear(); tryNextLine();
        for (int i = 0; i < 32; i++) {
            const char c = peekChar();
            if (c == '\n' || c == '\r' || eof()) break;
            result.push_back(c); bufPos++;
        }
        return result;
    }
    std::string_view nextUntilSpace() {
        result.clear();
        for (char c = peekChar(); std::isspace(c) && !eof(); c = peekChar()) {
            if (c == '\r' || c == '\n') tryNextLine(); else bufPos++;
        }
        if (eof()) return result;
        for (int i = 0; i < 32; i++) {
            const char c = peekChar();
            if (std::isspace(c) || eof()) break;
            result.push_back(c); bufPos++;
        }
        return result;
    }
};

static Verdict compareText(FILE *contestant, FILE *answer, int mode) {
    BufferedStreamReader output(contestant), reference(answer);
    for (;;) {
        const auto a = mode == 0 ? output.nextUntilNewLine() : output.nextUntilSpace();
        const auto b = mode == 0 ? reference.nextUntilNewLine() : reference.nextUntilSpace();
        if (mode == 0) {
            if (output.eof() && !reference.eof()) return WrongAnswer;
            if (!reference.eof() && output.eof()) return OutputLimit; // Upstream ordering retained.
            if (a != b) return WrongAnswer;
            if (output.eof() && reference.eof()) return Accepted;
        } else {
            if (a == b) {
                if (output.eof() && reference.eof()) return Accepted;
                if (output.line() != reference.line()) return PresentationError;
                continue;
            }
            if (a.size() == 0 && output.eof() && !reference.eof()) return WrongAnswer;
            if (b.size() == 0 && !reference.eof() && output.eof()) return OutputLimit;
            return WrongAnswer;
        }
    }
}
static Verdict compareReal(FILE *contestant, FILE *answer, int precision) {
    long double eps = 1;
    for (int i = 0; i < precision; i++) eps *= 0.1;
    long double a = NAN, b = NAN;
    for (;;) {
        const int ca = fscanf(contestant, "%Lf", &a), cb = fscanf(answer, "%Lf", &b);
        (void)fgetc(answer); // Native Lemon consumes one reference character after every scan.
        if (ca == 0) return WrongAnswer;
        if (cb == 0) return FileError;
        if (ca == EOF && cb == EOF) return Accepted;
        if (ca == EOF && cb == 1) return WrongAnswer;
        if (ca == 1 && cb == EOF) return OutputLimit;
        if (std::isnan(a) != std::isnan(b) || std::isinf(a) != std::isinf(b) ||
            (std::abs(a - b) > eps && std::abs(a - b) > eps * std::abs(b))) return WrongAnswer;
    }
}

// Arguments: mode precision input contestant_output reference_answer.
int main(int argc, char **argv) {
#ifdef TASKWEAVE_LEMON_MODE
    if (argc != 4) return FileError;
    const int mode = TASKWEAVE_LEMON_MODE, precision = TASKWEAVE_LEMON_PRECISION;
    const int outputIndex = 2, answerIndex = 3;
#else
    if (argc != 6) { fprintf(stderr, "FAIL expected mode precision input output answer\n"); return FileError; }
    const int mode = std::atoi(argv[1]), precision = std::atoi(argv[2]);
    const int outputIndex = 4, answerIndex = 5;
#endif
    if ((mode != 0 && mode != 1 && mode != 3) || precision < 0 || precision > 18) return FileError;
    FILE *output = nullptr, *answer = nullptr;
#ifdef _WIN32
    HMODULE shell = LoadLibraryW(L"shell32.dll");
    using Split = LPWSTR *(WINAPI *)(LPCWSTR, int *);
    auto split = shell ? reinterpret_cast<Split>(GetProcAddress(shell, "CommandLineToArgvW")) : nullptr;
    int count = 0; LPWSTR *arguments = split ? split(GetCommandLineW(), &count) : nullptr;
    if (arguments && count == argc) { output = _wfopen(arguments[outputIndex], L"r"); answer = _wfopen(arguments[answerIndex], L"r"); }
    if (arguments) LocalFree(arguments);
    if (shell) FreeLibrary(shell);
#else
    output = fopen(argv[outputIndex], "r"); answer = fopen(argv[answerIndex], "r");
#endif
    Verdict verdict = FileError;
    if (output && answer) verdict = mode == 3 ? compareReal(output, answer, precision) : compareText(output, answer, mode);
    if (output) fclose(output); if (answer) fclose(answer);
    const char *names[] = { "ok", "wrong answer", "wrong output format", "FAIL", "output limit exceeded" };
    fprintf(stderr, "%s: LemonLime native mode %d\n", names[verdict], mode);
#ifdef TASKWEAVE_LEMON_MODE
    return verdict == OutputLimit ? WrongAnswer : verdict;
#else
    return verdict;
#endif
}
