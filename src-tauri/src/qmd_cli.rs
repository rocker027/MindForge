//! Adapter for the optional external `qmd` retrieval CLI (ADR-0141).
//!
//! qmd is a user-installed binary (`npm install -g @tobilu/qmd`) detected at
//! runtime like a CLI agent — never bundled, never auto-installed. Absence is
//! a fully supported state: callers degrade to the built-in keyword search.
//!
//! Command execution is injectable via [`QmdExecutor`] and all output parsing
//! is pure, so tests never need a real qmd install.

use serde::Serialize;
use std::path::PathBuf;

mod discovery;

use discovery::find_qmd_binary;

/// Update command registered for memory-vault collections so `qmd update`
/// pulls the git remote before re-indexing (ADR-0141).
const COLLECTION_UPDATE_CMD: &str = "git pull --rebase";

/// Status returned by `qmd_status` (mirrors `ClaudeCliStatus`).
#[derive(Debug, Serialize, Clone)]
pub struct QmdStatus {
    pub installed: bool,
    pub version: Option<String>,
}

impl QmdStatus {
    fn not_installed() -> Self {
        Self {
            installed: false,
            version: None,
        }
    }
}

/// One search hit parsed from `qmd query --json` output.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct QmdHit {
    /// Collection-relative path (the `qmd://<collection>/` prefix is stripped).
    pub path: String,
    pub title: String,
    pub score: f64,
    pub snippet: String,
}

/// Captured output of a finished qmd invocation.
pub(crate) struct QmdOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `qmd` with the given arguments. Injectable so the parsing and flow
/// logic can be tested without a qmd install; `Err` means qmd could not be
/// invoked at all (as opposed to a non-zero exit, reported via `QmdOutput`).
pub(crate) trait QmdExecutor {
    fn run(&self, args: &[&str]) -> Result<QmdOutput, String>;
}

/// Production executor that spawns the discovered `qmd` binary.
pub(crate) struct SystemQmdExecutor {
    binary: PathBuf,
}

impl QmdExecutor for SystemQmdExecutor {
    fn run(&self, args: &[&str]) -> Result<QmdOutput, String> {
        let target =
            crate::cli_agent_runtime::command_target_avoiding_windows_cmd_shim(&self.binary)?;
        let mut command = crate::hidden_command(&target.program);
        crate::cli_agent_runtime::configure_agent_command_environment(&mut command, &self.binary);
        if let Some(first_arg) = target.first_arg {
            command.arg(first_arg);
        }
        let output = command
            .args(args)
            .output()
            .map_err(|error| format!("Failed to run qmd: {error}"))?;
        Ok(QmdOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Build an executor for the installed qmd binary, or `None` when qmd is
/// absent — the caller must treat absence as a supported degraded state.
pub(crate) fn system_executor() -> Option<SystemQmdExecutor> {
    find_qmd_binary().map(|binary| SystemQmdExecutor { binary })
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Check whether the `qmd` CLI is installed and return its version.
pub fn detect() -> QmdStatus {
    match system_executor() {
        Some(executor) => detect_with(&executor),
        None => QmdStatus::not_installed(),
    }
}

pub(crate) fn detect_with(executor: &dyn QmdExecutor) -> QmdStatus {
    match executor.run(&["--version"]) {
        Ok(output) if output.success => QmdStatus {
            installed: true,
            version: parse_version(&output.stdout),
        },
        _ => QmdStatus::not_installed(),
    }
}

/// Extract the version from `qmd --version` output, e.g. `qmd 0.6.5 (1a2b3c)`.
fn parse_version(stdout: &str) -> Option<String> {
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let version = match line.strip_prefix("qmd") {
        Some(rest) if rest.is_empty() || rest.starts_with(' ') => rest.trim(),
        _ => line,
    };
    (!version.is_empty()).then(|| version.to_string())
}

// ---------------------------------------------------------------------------
// Collection registration
// ---------------------------------------------------------------------------

/// Register `vault_path` as a qmd collection named `alias` unless one with
/// that name already exists (`qmd collection add` exits non-zero on
/// duplicates, so existence is checked via `qmd collection list` first).
/// Newly created collections get `git pull --rebase` as their update command.
/// Returns whether a new collection was registered.
pub(crate) fn ensure_collection(
    executor: &dyn QmdExecutor,
    vault_path: &str,
    alias: &str,
) -> Result<bool, String> {
    let listing = run_expecting_success(executor, &["collection", "list"], "collection list")?;
    if collection_names(&listing.stdout)
        .iter()
        .any(|name| name == alias)
    {
        return Ok(false);
    }

    run_expecting_success(
        executor,
        &["collection", "add", vault_path, "--name", alias],
        "collection add",
    )?;
    run_expecting_success(
        executor,
        &["collection", "update-cmd", alias, COLLECTION_UPDATE_CMD],
        "collection update-cmd",
    )?;
    Ok(true)
}

/// Parse collection names out of `qmd collection list` output. Each collection
/// header line contains its virtual URI, e.g. `notes (qmd://notes/)`, which
/// survives intact even when the surrounding text carries ANSI color codes.
fn collection_names(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(collection_name_from_line)
        .collect()
}

fn collection_name_from_line(line: &str) -> Option<String> {
    let marker = "(qmd://";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find(['/', ')'])?;
    let name = &rest[..end];
    (!name.is_empty()).then(|| name.to_string())
}

// ---------------------------------------------------------------------------
// Index refresh
// ---------------------------------------------------------------------------

/// Re-index the collection (running its configured update command, e.g.
/// `git pull --rebase`) and refresh vector embeddings. Long-running — callers
/// must keep this off the UI thread (`spawn_blocking`).
pub(crate) fn update_index(executor: &dyn QmdExecutor, alias: &str) -> Result<(), String> {
    run_expecting_success(executor, &["update", "-c", alias], "update")?;
    run_expecting_success(executor, &["embed", "-c", alias], "embed")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// Run a hybrid search against one collection and parse the JSON results.
pub(crate) fn query_collection(
    executor: &dyn QmdExecutor,
    query_text: &str,
    alias: &str,
    limit: u32,
) -> Result<Vec<QmdHit>, String> {
    let limit_text = limit.to_string();
    let output = run_expecting_success(
        executor,
        &[
            "query",
            "--json",
            "-c",
            alias,
            "-n",
            &limit_text,
            query_text,
        ],
        "query",
    )?;
    parse_query_hits(&output.stdout)
}

/// Parse `qmd query --json` output. Tolerant by design: unknown fields are
/// ignored, missing fields fall back to defaults, and non-object array items
/// are skipped. Only non-JSON output is an error.
fn parse_query_hits(stdout: &str) -> Result<Vec<QmdHit>, String> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Failed to parse qmd query output: {error}"))?;
    let items = value
        .as_array()
        .ok_or("qmd query output is not a JSON array")?;
    Ok(items.iter().filter_map(hit_from_value).collect())
}

fn hit_from_value(value: &serde_json::Value) -> Option<QmdHit> {
    let object = value.as_object()?;
    Some(QmdHit {
        path: collection_relative_path(&string_field(object, "file")),
        title: string_field(object, "title"),
        score: object
            .get("score")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0),
        snippet: string_field(object, "snippet"),
    })
}

fn string_field(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// qmd reports hits as `qmd://<collection>/<path>` URIs; strip the scheme and
/// collection segment so callers get a path relative to the vault root.
fn collection_relative_path(file: &str) -> String {
    let Some(rest) = file.strip_prefix("qmd://") else {
        return file.to_string();
    };
    rest.split_once('/')
        .map(|(_, path)| path)
        .unwrap_or(rest)
        .to_string()
}

// ---------------------------------------------------------------------------
// Failure formatting
// ---------------------------------------------------------------------------

fn run_expecting_success(
    executor: &dyn QmdExecutor,
    args: &[&str],
    action: &str,
) -> Result<QmdOutput, String> {
    let output = executor.run(args)?;
    if output.success {
        Ok(output)
    } else {
        Err(format_qmd_failure(action, &output))
    }
}

fn format_qmd_failure(action: &str, output: &QmdOutput) -> String {
    let detail = output
        .stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");
    if detail.is_empty() {
        format!("qmd {action} failed")
    } else {
        format!("qmd {action} failed: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// Test double that replays canned outputs and records every invocation.
    struct ScriptedExecutor {
        responses: RefCell<VecDeque<Result<QmdOutput, String>>>,
        calls: RefCell<Vec<Vec<String>>>,
    }

    impl ScriptedExecutor {
        fn new(responses: Vec<Result<QmdOutput, String>>) -> Self {
            Self {
                responses: RefCell::new(responses.into()),
                calls: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.borrow().clone()
        }
    }

    impl QmdExecutor for ScriptedExecutor {
        fn run(&self, args: &[&str]) -> Result<QmdOutput, String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|arg| arg.to_string()).collect());
            self.responses
                .borrow_mut()
                .pop_front()
                .expect("ScriptedExecutor ran out of responses")
        }
    }

    fn success(stdout: &str) -> Result<QmdOutput, String> {
        Ok(QmdOutput {
            success: true,
            stdout: stdout.to_string(),
            stderr: String::new(),
        })
    }

    fn failure(stderr: &str) -> Result<QmdOutput, String> {
        Ok(QmdOutput {
            success: false,
            stdout: String::new(),
            stderr: stderr.to_string(),
        })
    }

    const COLLECTION_LISTING: &str = concat!(
        "Collections (2):\n",
        "\n",
        "memory (qmd://memory/)\n",
        "  Pattern:  **/*.md\n",
        "  Files:    12\n",
        "  Updated:  2 hours ago\n",
        "\n",
        "notes (qmd://notes/) [excluded]\n",
        "  Pattern:  **/*.md\n",
        "  Files:    340\n",
        "  Updated:  1 day ago\n",
    );

    // --- version parsing / detection ---

    #[test]
    fn parse_version_strips_qmd_prefix() {
        assert_eq!(parse_version("qmd 0.6.5\n"), Some("0.6.5".to_string()));
    }

    #[test]
    fn parse_version_keeps_commit_suffix() {
        assert_eq!(
            parse_version("qmd 0.6.5 (1a2b3c)\n"),
            Some("0.6.5 (1a2b3c)".to_string())
        );
    }

    #[test]
    fn parse_version_accepts_bare_version() {
        assert_eq!(parse_version("0.7.0"), Some("0.7.0".to_string()));
    }

    #[test]
    fn parse_version_skips_blank_lines() {
        assert_eq!(parse_version("\n\nqmd 1.0.0\n"), Some("1.0.0".to_string()));
    }

    #[test]
    fn parse_version_rejects_empty_output() {
        assert_eq!(parse_version("\n  \n"), None);
        assert_eq!(parse_version("qmd "), None);
    }

    #[test]
    fn detect_with_reports_installed_version() {
        let executor = ScriptedExecutor::new(vec![success("qmd 0.6.5\n")]);

        let status = detect_with(&executor);

        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("0.6.5"));
        assert_eq!(executor.calls(), vec![vec!["--version".to_string()]]);
    }

    #[test]
    fn detect_with_treats_nonzero_exit_as_not_installed() {
        let executor = ScriptedExecutor::new(vec![failure("boom")]);

        let status = detect_with(&executor);

        assert!(!status.installed);
        assert!(status.version.is_none());
    }

    #[test]
    fn detect_with_treats_spawn_failure_as_not_installed() {
        let executor = ScriptedExecutor::new(vec![Err("no qmd".to_string())]);

        let status = detect_with(&executor);

        assert!(!status.installed);
    }

    #[test]
    fn detect_handles_missing_or_present_install() {
        let status = detect();
        if status.installed {
            assert!(status.version.is_some());
        } else {
            assert!(status.version.is_none());
        }
    }

    // --- collection list parsing ---

    #[test]
    fn collection_names_extracts_names_from_listing() {
        assert_eq!(
            collection_names(COLLECTION_LISTING),
            vec!["memory", "notes"]
        );
    }

    #[test]
    fn collection_names_survive_ansi_color_codes() {
        let colored = "\u{1b}[36mmemory\u{1b}[0m \u{1b}[2m(qmd://memory/)\u{1b}[0m\n";
        assert_eq!(collection_names(colored), vec!["memory"]);
    }

    #[test]
    fn collection_names_empty_for_no_collections_message() {
        let stdout = "No collections found. Run 'qmd collection add .' to create one.\n";
        assert!(collection_names(stdout).is_empty());
    }

    #[test]
    fn collection_name_from_line_ignores_lines_without_uri() {
        assert_eq!(collection_name_from_line("  Pattern:  **/*.md"), None);
        assert_eq!(collection_name_from_line("broken (qmd://"), None);
    }

    // --- ensure_collection ---

    #[test]
    fn ensure_collection_skips_existing_alias() {
        let executor = ScriptedExecutor::new(vec![success(COLLECTION_LISTING)]);

        let created = ensure_collection(&executor, "/tmp/memory-vault", "memory").unwrap();

        assert!(!created);
        assert_eq!(executor.calls().len(), 1, "must not run collection add");
    }

    #[test]
    fn ensure_collection_registers_and_sets_update_cmd() {
        let executor = ScriptedExecutor::new(vec![
            success("No collections found. Run 'qmd collection add .' to create one.\n"),
            success("Collection added"),
            success("Update command set"),
        ]);

        let created = ensure_collection(&executor, "/tmp/memory-vault", "memory").unwrap();

        assert!(created);
        assert_eq!(
            executor.calls(),
            vec![
                vec!["collection".to_string(), "list".to_string()],
                vec![
                    "collection".to_string(),
                    "add".to_string(),
                    "/tmp/memory-vault".to_string(),
                    "--name".to_string(),
                    "memory".to_string(),
                ],
                vec![
                    "collection".to_string(),
                    "update-cmd".to_string(),
                    "memory".to_string(),
                    "git pull --rebase".to_string(),
                ],
            ]
        );
    }

    #[test]
    fn ensure_collection_surfaces_add_failure() {
        let executor = ScriptedExecutor::new(vec![
            success(""),
            failure("Collection 'memory' already exists.\nUse a different name"),
        ]);

        let error = ensure_collection(&executor, "/tmp/memory-vault", "memory").unwrap_err();

        assert!(error.contains("qmd collection add failed"));
        assert!(error.contains("already exists"));
    }

    // --- update_index ---

    #[test]
    fn update_index_runs_update_then_embed() {
        let executor = ScriptedExecutor::new(vec![success("updated"), success("embedded")]);

        update_index(&executor, "memory").unwrap();

        assert_eq!(
            executor.calls(),
            vec![
                vec!["update".to_string(), "-c".to_string(), "memory".to_string()],
                vec!["embed".to_string(), "-c".to_string(), "memory".to_string()],
            ]
        );
    }

    #[test]
    fn update_index_surfaces_embed_failure() {
        let executor =
            ScriptedExecutor::new(vec![success("updated"), failure("model download failed")]);

        let error = update_index(&executor, "memory").unwrap_err();

        assert!(error.contains("qmd embed failed"));
        assert!(error.contains("model download failed"));
    }

    // --- query parsing ---

    #[test]
    fn query_collection_passes_args_and_parses_hits() {
        let executor = ScriptedExecutor::new(vec![success(
            r##"[
                {
                    "docid": "#a1b2c3",
                    "score": 0.89,
                    "file": "qmd://memory/wiki/rust.md",
                    "line": 12,
                    "title": "Rust",
                    "context": "Memory vault",
                    "snippet": "Ownership and borrowing"
                }
            ]"##,
        )]);

        let hits = query_collection(&executor, "ownership", "memory", 5).unwrap();

        assert_eq!(
            executor.calls(),
            vec![vec![
                "query".to_string(),
                "--json".to_string(),
                "-c".to_string(),
                "memory".to_string(),
                "-n".to_string(),
                "5".to_string(),
                "ownership".to_string(),
            ]]
        );
        assert_eq!(
            hits,
            vec![QmdHit {
                path: "wiki/rust.md".to_string(),
                title: "Rust".to_string(),
                score: 0.89,
                snippet: "Ownership and borrowing".to_string(),
            }]
        );
    }

    #[test]
    fn parse_query_hits_defaults_missing_fields() {
        let hits = parse_query_hits(r#"[{"file": "wiki/empty.md"}]"#).unwrap();

        assert_eq!(
            hits,
            vec![QmdHit {
                path: "wiki/empty.md".to_string(),
                title: String::new(),
                score: 0.0,
                snippet: String::new(),
            }]
        );
    }

    #[test]
    fn parse_query_hits_ignores_unknown_fields_and_non_objects() {
        let hits = parse_query_hits(
            r#"[
                {"file": "qmd://m/a.md", "title": "A", "score": 0.5, "future_field": {"x": 1}},
                "not an object",
                42
            ]"#,
        )
        .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");
    }

    #[test]
    fn parse_query_hits_handles_empty_result_set() {
        assert!(parse_query_hits("[]\n").unwrap().is_empty());
    }

    #[test]
    fn parse_query_hits_rejects_malformed_json() {
        let error = parse_query_hits("loading models...\n[{}]").unwrap_err();
        assert!(error.contains("Failed to parse qmd query output"));
    }

    #[test]
    fn parse_query_hits_rejects_non_array_json() {
        let error = parse_query_hits(r#"{"error": "no index"}"#).unwrap_err();
        assert!(error.contains("not a JSON array"));
    }

    #[test]
    fn collection_relative_path_strips_scheme_and_collection() {
        assert_eq!(
            collection_relative_path("qmd://memory/wiki/rust.md"),
            "wiki/rust.md"
        );
        assert_eq!(collection_relative_path("wiki/rust.md"), "wiki/rust.md");
        assert_eq!(collection_relative_path("qmd://memory"), "memory");
    }

    // --- failure formatting ---

    #[test]
    fn format_qmd_failure_without_stderr_reports_action() {
        let output = QmdOutput {
            success: false,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(format_qmd_failure("update", &output), "qmd update failed");
    }

    #[test]
    fn format_qmd_failure_truncates_stderr_to_three_lines() {
        let output = QmdOutput {
            success: false,
            stdout: String::new(),
            stderr: "one\ntwo\nthree\nfour\n".to_string(),
        };
        let message = format_qmd_failure("embed", &output);
        assert!(message.contains("three"));
        assert!(!message.contains("four"));
    }
}
