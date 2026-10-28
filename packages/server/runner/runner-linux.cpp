// Taskweave Linux runner. Same result contract as runner.cpp; argv is transported
// as repeated arg= lines and passed directly to execvp, without a shell.
// CPU and resident-memory accounting cover the observed process tree. Limits are
// checked every 5 ms; rlimits additionally bound CPU seconds and regular-file output.
// This is local judging/resource supervision, not a filesystem/network sandbox.

#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
volatile sig_atomic_t interrupted = 0;
void stop(int) { interrupted = 1; }

struct Spec {
  std::vector<std::string> argv;
  std::string cwd, in, out, err;
  long long timeLimit = 0, wallLimit = 0, memoryLimit = 0, outputLimit = 0;
  long long processLimit = 1;
};
struct Result {
  std::string status = "IE", error;
  int exitCode = 0;
  long long timeMs = 0, wallMs = 0, memoryKb = 0;
  bool idle = false;
};
struct Proc {
  Spec spec;
  Result res;
  pid_t pid = -1;
  int gate = -1, errors = -1, output = -1;
  std::map<pid_t, unsigned long long> members;
  std::string killed;
  Clock::time_point start;
  bool running = false;
};
void closeFd(int& fd) { if (fd >= 0) close(fd); fd = -1; }
long long elapsed(const Proc& p) { return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - p.start).count(); }
std::string error(const char* what) { return std::string(what) + ": " + std::strerror(errno); }

std::string jsonEscape(const std::string& value) {
  std::string out;
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c < 32) { char escaped[8]; std::snprintf(escaped, sizeof escaped, "\\u%04x", c); out += escaped; }
    else out += static_cast<char>(c);
  }
  return out;
}
std::string toJson(const Result& r) {
  return "{\"status\":\"" + r.status + "\",\"exit_code\":" + std::to_string(r.exitCode) +
    ",\"time_ms\":" + std::to_string(r.timeMs) + ",\"wall_ms\":" + std::to_string(r.wallMs) +
    ",\"memory_kb\":" + std::to_string(r.memoryKb) + ",\"idle\":" + (r.idle ? "true" : "false") +
    ",\"error\":\"" + jsonEscape(r.error) + "\"}";
}
bool parseSpec(const std::string& text, Spec& sol, Spec& inter, bool& interactive) {
  Spec* current = &sol;
  std::istringstream stream(text);
  std::string line;
  while (std::getline(stream, line)) {
    if (line == "[interactor]") { interactive = true; current = &inter; continue; }
    const auto at = line.find('=');
    if (at == std::string::npos) continue;
    const auto key = line.substr(0, at), value = line.substr(at + 1);
    if (key == "arg") current->argv.push_back(value);
    else if (key == "cwd") current->cwd = value;
    else if (key == "stdin") current->in = value;
    else if (key == "stdout") current->out = value;
    else if (key == "stderr") current->err = value;
    else if (key == "time_limit") current->timeLimit = std::atoll(value.c_str());
    else if (key == "wall_limit") current->wallLimit = std::atoll(value.c_str());
    else if (key == "memory_limit") current->memoryLimit = std::atoll(value.c_str());
    else if (key == "output_limit") current->outputLimit = std::atoll(value.c_str());
    else if (key == "process_limit") current->processLimit = std::atoll(value.c_str());
  }
  return !sol.argv.empty() && !sol.argv[0].empty() && (!interactive || (!inter.argv.empty() && !inter.argv[0].empty()));
}
int openFile(const std::string& file, bool write) {
  return open(file.empty() ? "/dev/null" : file.c_str(), O_CLOEXEC | (write ? O_WRONLY | O_CREAT | O_TRUNC : O_RDONLY), 0600);
}

struct Usage {
  unsigned long long started = 0;
  long long ticks = 0, memoryKb = 0;
};
bool usage(pid_t pid, Usage& out) {
  std::ifstream stat("/proc/" + std::to_string(pid) + "/stat");
  std::string line;
  if (!std::getline(stat, line)) return false;
  const auto at = line.rfind(')');
  if (at == std::string::npos) return false;
  std::istringstream fields(line.substr(at + 2));
  std::vector<std::string> values;
  for (std::string value; fields >> value;) values.push_back(value);
  if (values.size() < 22) return false;
  // values[0] is field 3 (state); fields 14..17 are own and waited-child CPU.
  for (int index : {11, 12, 13, 14}) out.ticks += std::atoll(values[index].c_str());
  out.started = std::strtoull(values[19].c_str(), nullptr, 10);
  out.memoryKb = std::max(0LL, std::atoll(values[21].c_str())) * sysconf(_SC_PAGESIZE) / 1024;
  return true;
}
void discover(Proc& p, pid_t pid) {
  DIR* tasks = opendir(("/proc/" + std::to_string(pid) + "/task").c_str());
  if (!tasks) return;
  while (auto* entry = readdir(tasks)) {
    if (entry->d_name[0] == '.') continue;
    std::ifstream children("/proc/" + std::to_string(pid) + "/task/" + entry->d_name + "/children");
    for (pid_t child; children >> child;) {
      if (p.members.count(child)) continue;
      Usage found;
      if (usage(child, found)) { p.members[child] = found.started; discover(p, child); }
    }
  }
  closedir(tasks);
}
void killTree(Proc& p) {
  if (p.pid <= 0) return;
  // Keep the root unreaped while killing its process group, so its PID cannot be reused.
  kill(-p.pid, SIGKILL);
  for (const auto& [pid, started] : p.members) {
    Usage now;
    if (usage(pid, now) && now.started == started) kill(pid, SIGKILL);
  }
}

[[noreturn]] void childError(int fd, const char* what) {
  const std::string message = error(what);
  const auto ignored = write(fd, message.data(), message.size()); (void)ignored;
  _exit(127);
}
bool create(Proc& p, int input, int output, int stderrFd) {
  int gate[2] = {-1, -1}, errors[2] = {-1, -1};
  if (pipe2(gate, O_CLOEXEC) || pipe2(errors, O_CLOEXEC | O_NONBLOCK)) {
    p.res.error = error("pipe2");
    for (int fd : {gate[0], gate[1], errors[0], errors[1]}) if (fd >= 0) close(fd);
    return false;
  }
  const pid_t parent = getpid();
  p.pid = fork();
  if (p.pid == 0) {
    close(gate[1]); close(errors[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || setpgid(0, 0)) childError(errors[1], "process setup");
    if (getppid() != parent) _exit(127);
    signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (dup2(input, STDIN_FILENO) < 0 || dup2(output, STDOUT_FILENO) < 0 || dup2(stderrFd, STDERR_FILENO) < 0) childError(errors[1], "redirect");
    if (!p.spec.cwd.empty() && chdir(p.spec.cwd.c_str())) childError(errors[1], "chdir");
    rlimit core{0, 0}; if (setrlimit(RLIMIT_CORE, &core)) childError(errors[1], "core limit");
    if (p.spec.timeLimit > 0) {
      const rlim_t seconds = static_cast<rlim_t>((p.spec.timeLimit + 999) / 1000);
      rlimit cpu{seconds, seconds + 1}; if (setrlimit(RLIMIT_CPU, &cpu)) childError(errors[1], "CPU limit");
    }
    if (p.spec.outputLimit > 0) {
      const auto limit = static_cast<rlim_t>(p.spec.outputLimit);
      rlimit size{limit, limit}; if (setrlimit(RLIMIT_FSIZE, &size)) childError(errors[1], "output limit");
    }
    char start;
    ssize_t got;
    do { got = read(gate[0], &start, 1); } while (got < 0 && errno == EINTR);
    if (got != 1) _exit(127);
    close(gate[0]);
    std::vector<char*> argv;
    for (auto& arg : p.spec.argv) argv.push_back(arg.data());
    argv.push_back(nullptr);
    execvp(argv[0], argv.data());
    childError(errors[1], "execvp");
  }
  close(gate[0]); close(errors[1]);
  if (p.pid < 0) { p.res.error = error("fork"); close(gate[1]); close(errors[0]); return false; }
  setpgid(p.pid, p.pid);
  p.gate = gate[1]; p.errors = errors[0];
  Usage initial;
  if (usage(p.pid, initial)) p.members[p.pid] = initial.started;
  return true;
}
void resume(Proc& p) {
  p.start = Clock::now(); p.running = true;
  const char start = 1; const auto ignored = write(p.gate, &start, 1); (void)ignored;
  closeFd(p.gate);
}
void readErrors(Proc& p) {
  if (p.errors < 0) return;
  char buffer[2048];
  for (;;) {
    const auto n = read(p.errors, buffer, sizeof buffer);
    if (n > 0) { if (p.res.error.size() < 4096) p.res.error.append(buffer, n); }
    else { if (!n) closeFd(p.errors); break; }
  }
}
void measure(Proc& p) {
  // Forks may originate on any thread. Also revisit known children whose parent exited.
  discover(p, p.pid);
  for (auto it = p.members.begin(); it != p.members.end(); ++it) if (it->first != p.pid) discover(p, it->first);
  long long ticks = 0, memory = 0, processes = 0;
  for (const auto& [pid, started] : p.members) {
    Usage now;
    if (usage(pid, now) && now.started == started) { ticks += now.ticks; memory += now.memoryKb; ++processes; }
  }
  p.res.timeMs = std::max(p.res.timeMs, ticks * 1000 / sysconf(_SC_CLK_TCK));
  p.res.memoryKb = std::max(p.res.memoryKb, memory);
  if (!p.killed.empty()) return;
  if (p.spec.timeLimit > 0 && p.res.timeMs > p.spec.timeLimit) p.killed = "TL";
  else if (p.spec.wallLimit > 0 && elapsed(p) > p.spec.wallLimit) { p.killed = "TL"; p.res.idle = p.spec.timeLimit > 0 && p.res.timeMs < p.spec.timeLimit; }
  else if (p.spec.memoryLimit > 0 && memory * 1024 > p.spec.memoryLimit) p.killed = "ML";
  else if (processes > std::max(1LL, p.spec.processLimit)) { p.killed = "RE"; p.res.error = "process limit exceeded"; }
  if (p.spec.outputLimit > 0 && p.output >= 0) {
    struct stat file{};
    if (fstat(p.output, &file) == 0 && file.st_size > p.spec.outputLimit) p.killed = "OL";
  }
}
void finish(Proc& p) {
  killTree(p);
  int status = 0; rusage used{};
  while (wait4(p.pid, &status, 0, &used) < 0 && errno == EINTR) {}
  readErrors(p);
  p.res.wallMs = elapsed(p);
  const auto micros = (used.ru_utime.tv_sec + used.ru_stime.tv_sec) * 1000000LL + used.ru_utime.tv_usec + used.ru_stime.tv_usec;
  p.res.timeMs = std::max(p.res.timeMs, (micros + 999) / 1000);
  p.res.memoryKb = std::max(p.res.memoryKb, static_cast<long long>(used.ru_maxrss));
  p.res.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  if (!p.killed.empty()) p.res.status = p.killed;
  else if (!p.res.error.empty()) p.res.status = "IE";
  else if (WIFSIGNALED(status) && WTERMSIG(status) == SIGXCPU) p.res.status = "TL";
  else if (WIFSIGNALED(status) && WTERMSIG(status) == SIGXFSZ) p.res.status = "OL";
  else if (p.spec.timeLimit > 0 && p.res.timeMs > p.spec.timeLimit) p.res.status = "TL";
  else if (p.spec.memoryLimit > 0 && p.res.memoryKb * 1024 > p.spec.memoryLimit) p.res.status = "ML";
  else p.res.status = p.res.exitCode ? "RE" : "OK";
  p.running = false; closeFd(p.errors); closeFd(p.output);
}
void runAll(const std::vector<Proc*>& procs) {
  for (;;) {
    bool running = false;
    for (Proc* p : procs) {
      if (!p->running) continue;
      readErrors(*p); measure(*p);
      if (interrupted) { p->killed = "IE"; p->res.error = "runner cancelled"; }
      if (!p->killed.empty()) killTree(*p);
      siginfo_t info{};
      if (waitid(P_PID, p->pid, &info, WEXITED | WNOHANG | WNOWAIT) == 0 && info.si_pid) finish(*p);
      else running = true;
    }
    if (!running) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  // Reap orphaned descendants after cancelling or finishing their parent.
  for (int i = 0; i < 100; ++i) {
    int status; pid_t pid = waitpid(-1, &status, WNOHANG);
    if (pid < 0 && errno == ECHILD) break;
    if (pid == 0) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
}
void abandon(Proc& p) {
  if (p.pid <= 0) return;
  p.start = Clock::now(); p.running = true; p.killed = "IE";
  closeFd(p.gate); killTree(p);
}
} // namespace

int main() {
  signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
  prctl(PR_SET_CHILD_SUBREAPER, 1);
  std::string text;
  char buffer[4096];
  for (size_t n; (n = std::fread(buffer, 1, sizeof buffer, stdin)) > 0;) text.append(buffer, n);
  Proc sol, inter; bool interactive = false;
  if (!parseSpec(text, sol.spec, inter.spec, interactive)) {
    sol.res.error = "invalid spec"; std::printf("%s\n", toJson(sol.res).c_str()); return 2;
  }
  if (!interactive) {
    int input = openFile(sol.spec.in, false), output = openFile(sol.spec.out, true), stderrFd = openFile(sol.spec.err, true);
    if (input < 0 || output < 0 || stderrFd < 0) sol.res.error = error("open redirection");
    else if (create(sol, input, output, stderrFd)) {
      if (!sol.spec.out.empty()) sol.output = fcntl(output, F_DUPFD_CLOEXEC, 3);
      closeFd(input); closeFd(output); closeFd(stderrFd);
      resume(sol); runAll({&sol});
    }
    closeFd(input); closeFd(output); closeFd(stderrFd);
    std::printf("%s\n", toJson(sol.res).c_str());
    return 0;
  }
  int s2i[2] = {-1, -1}, i2s[2] = {-1, -1};
  int solErr = openFile(sol.spec.err, true), intErr = openFile(inter.spec.err, true);
  if (solErr < 0 || intErr < 0 || pipe2(s2i, O_CLOEXEC) || pipe2(i2s, O_CLOEXEC)) sol.res.error = inter.res.error = error("interactive pipes");
  else {
    const bool ok = create(inter, s2i[0], i2s[1], intErr) && create(sol, i2s[0], s2i[1], solErr);
    for (int& fd : s2i) closeFd(fd);
    for (int& fd : i2s) closeFd(fd);
    closeFd(solErr); closeFd(intErr);
    if (ok) { resume(inter); resume(sol); }
    else { abandon(inter); abandon(sol); }
    runAll({&sol, &inter});
  }
  for (int& fd : s2i) closeFd(fd);
  for (int& fd : i2s) closeFd(fd);
  closeFd(solErr); closeFd(intErr);
  std::printf("{\"solution\":%s,\"interactor\":%s}\n", toJson(sol.res).c_str(), toJson(inter.res).c_str());
  return 0;
}
