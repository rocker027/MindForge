//! Locates the user-installed `qmd` binary (PATH, login shell, known
//! npm/bun global install locations). Mirrors the Claude CLI discovery flow.

use std::path::{Path, PathBuf};

pub(crate) fn find_qmd_binary() -> Option<PathBuf> {
    find_qmd_binary_on_path()
        .or_else(find_qmd_binary_in_user_shell)
        .or_else(|| {
            crate::cli_agent_runtime::find_executable_binary_candidate(
                qmd_binary_candidates(),
                "qmd CLI",
            )
            .ok()
            .flatten()
        })
}

fn find_qmd_binary_on_path() -> Option<PathBuf> {
    let lookup = if cfg!(windows) { "where" } else { "which" };
    crate::hidden_command(lookup)
        .arg("qmd")
        .output()
        .ok()
        .and_then(|output| path_from_successful_output(&output))
}

fn find_qmd_binary_in_user_shell() -> Option<PathBuf> {
    user_shell_candidates()
        .into_iter()
        .filter(|shell| shell.exists())
        .find_map(|shell| qmd_path_from_shell(&shell))
}

fn user_shell_candidates() -> Vec<PathBuf> {
    let mut shells = Vec::new();
    if let Some(shell) = std::env::var_os("SHELL") {
        if !shell.is_empty() {
            shells.push(PathBuf::from(shell));
        }
    }
    shells.push(PathBuf::from("/bin/zsh"));
    shells.push(PathBuf::from("/bin/bash"));
    shells
}

fn qmd_path_from_shell(shell: &Path) -> Option<PathBuf> {
    crate::hidden_command(shell)
        .arg("-lc")
        .arg("command -v qmd")
        .output()
        .ok()
        .and_then(|output| path_from_successful_output(&output))
}

fn path_from_successful_output(output: &std::process::Output) -> Option<PathBuf> {
    if !output.status.success() {
        return None;
    }
    first_existing_path(&String::from_utf8_lossy(&output.stdout), cfg!(windows))
}

fn first_existing_path(stdout: &str, windows: bool) -> Option<PathBuf> {
    let mut paths = stdout.lines().filter_map(existing_path);
    if windows {
        return paths.find(|path| crate::cli_agent_runtime::has_windows_cli_extension(path));
    }
    paths.next()
}

fn existing_path(line: &str) -> Option<PathBuf> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(trimmed);
    candidate.exists().then_some(candidate)
}

fn qmd_binary_candidates() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|home| qmd_binary_candidates_for_home(&home))
        .unwrap_or_default()
}

/// Well-known install locations for npm/bun global packages, mirroring the
/// Claude CLI candidate list (qmd ships on npm as `@tobilu/qmd`).
fn qmd_binary_candidates_for_home(home: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        home.join(".local/bin/qmd"),
        home.join(".local/bin/qmd.exe"),
        home.join(".bun/bin/qmd"),
        home.join(".bun/bin/qmd.exe"),
        home.join(".local/share/mise/shims/qmd"),
        home.join(".asdf/shims/qmd"),
        home.join(".npm-global/bin/qmd"),
        home.join(".npm-global/bin/qmd.cmd"),
        home.join(".npm/bin/qmd"),
        home.join("AppData/Roaming/npm/qmd.cmd"),
        home.join("AppData/Roaming/npm/qmd.exe"),
        home.join("AppData/Local/pnpm/qmd.cmd"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin/qmd"),
        PathBuf::from("/opt/homebrew/bin/qmd"),
        PathBuf::from("/usr/local/bin/qmd"),
    ];
    candidates.extend(nvm_qmd_binary_candidates_for_home(home));
    candidates
}

fn nvm_qmd_binary_candidates_for_home(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) else {
        return Vec::new();
    };

    let mut candidates = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .map(|path| path.join("bin").join("qmd"))
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qmd_binary_candidates_include_npm_and_bun_installs() {
        let home = PathBuf::from("/Users/alex");
        let candidates = qmd_binary_candidates_for_home(&home);

        for expected in [
            home.join(".npm-global/bin/qmd"),
            home.join(".bun/bin/qmd"),
            PathBuf::from("/opt/homebrew/bin/qmd"),
        ] {
            assert!(
                candidates.contains(&expected),
                "missing {}",
                expected.display()
            );
        }
    }

    #[test]
    fn qmd_binary_candidates_include_nvm_managed_node_installs() {
        let home = tempfile::tempdir().unwrap();
        let qmd = home.path().join(".nvm/versions/node/v22.12.0/bin/qmd");
        std::fs::create_dir_all(qmd.parent().unwrap()).unwrap();
        std::fs::write(&qmd, "#!/bin/sh\n").unwrap();

        let candidates = qmd_binary_candidates_for_home(home.path());

        assert!(candidates.contains(&qmd), "missing {}", qmd.display());
    }

    #[test]
    fn first_existing_path_on_windows_requires_cli_extension() {
        let dir = tempfile::tempdir().unwrap();
        let shell_script = dir.path().join("qmd");
        let cmd_shim = dir.path().join("qmd.cmd");
        std::fs::write(&shell_script, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd_shim, "@ECHO off\n").unwrap();
        let stdout = format!("{}\n{}\n", shell_script.display(), cmd_shim.display());

        assert_eq!(first_existing_path(&stdout, true), Some(cmd_shim));
        assert_eq!(first_existing_path(&stdout, false), Some(shell_script));
    }
}
