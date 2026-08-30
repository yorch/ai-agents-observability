// aiot launcher — a tiny native binary that execs the Bun-compiled runtime.
//
// macOS Background Task Management (BTM) attributes background processes to
// the code-signing identity of the executable backing a LaunchAgent. When the
// Bun runtime is that executable, BTM shows "Jarred Sumner" (Bun's author)
// instead of our tool name. This launcher is the executable that launchd
// invokes, so BTM reads *our* signature, not Bun's.
//
// The launcher finds `aiot-runtime` next to itself and execv's it with all
// arguments passed through. The overhead is a single execv (~1 ms).

use std::env;
use std::os::unix::process::CommandExt;
use std::process::Command;

fn main() {
    let exe = env::current_exe().unwrap_or_else(|e| {
        eprintln!("aiot: cannot determine launcher path: {e}");
        std::process::exit(1);
    });

    let dir = exe.parent().unwrap_or_else(|| {
        eprintln!("aiot: cannot determine launcher directory");
        std::process::exit(1);
    });

    let runtime = dir.join("aiot-runtime");

    if !runtime.exists() {
        eprintln!("aiot: runtime binary not found at {}", runtime.display());
        eprintln!(
            "aiot: reinstall with: curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash"
        );
        std::process::exit(127);
    }

    let args: Vec<String> = env::args().skip(1).collect();
    let mut cmd = Command::new(&runtime);
    cmd.args(&args);

    // exec replaces this process — no return on success.
    let err = cmd.exec();
    eprintln!("aiot: failed to start runtime: {err}");
    std::process::exit(1);
}
