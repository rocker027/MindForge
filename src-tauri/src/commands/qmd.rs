use serde::Serialize;

use super::expand_tilde;
use crate::qmd_cli::{self, QmdHit, QmdStatus};

const DEFAULT_QUERY_LIMIT: u32 = 10;

/// Result of a memory query. `available: false` means qmd is not installed —
/// a supported state, never an error — and callers should fall back to the
/// built-in keyword search (ADR-0141).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QmdQueryResponse {
    pub available: bool,
    pub hits: Vec<QmdHit>,
}

impl QmdQueryResponse {
    fn unavailable() -> Self {
        Self {
            available: false,
            hits: Vec::new(),
        }
    }
}

/// Result of an index refresh, including whether the collection had to be
/// registered first.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QmdIndexReport {
    pub available: bool,
    pub collection_created: bool,
    pub indexed: bool,
}

impl QmdIndexReport {
    fn unavailable() -> Self {
        Self {
            available: false,
            collection_created: false,
            indexed: false,
        }
    }
}

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| format!("Task failed: {error}"))
}

/// Check whether the `qmd` CLI is installed and return its version.
#[tauri::command]
pub async fn qmd_status() -> Result<QmdStatus, String> {
    run_blocking(qmd_cli::detect).await
}

/// Run a hybrid memory search against a qmd collection.
#[tauri::command]
pub async fn qmd_memory_query(
    query: String,
    collection: String,
    limit: Option<u32>,
) -> Result<QmdQueryResponse, String> {
    run_blocking(move || memory_query(&query, &collection, limit.unwrap_or(DEFAULT_QUERY_LIMIT)))
        .await?
}

/// Register the vault as a qmd collection (idempotent) and refresh its index
/// and embeddings. Long-running; intended for background invocation.
#[tauri::command]
pub async fn qmd_update_index(
    vault_path: String,
    collection: String,
) -> Result<QmdIndexReport, String> {
    run_blocking(move || refresh_index(&vault_path, &collection)).await?
}

fn memory_query(query: &str, collection: &str, limit: u32) -> Result<QmdQueryResponse, String> {
    let Some(executor) = qmd_cli::system_executor() else {
        return Ok(QmdQueryResponse::unavailable());
    };
    memory_query_with(&executor, query, collection, limit)
}

fn memory_query_with(
    executor: &dyn qmd_cli::QmdExecutor,
    query: &str,
    collection: &str,
    limit: u32,
) -> Result<QmdQueryResponse, String> {
    let hits = qmd_cli::query_collection(executor, query, collection, limit)?;
    Ok(QmdQueryResponse {
        available: true,
        hits,
    })
}

fn refresh_index(vault_path: &str, collection: &str) -> Result<QmdIndexReport, String> {
    let Some(executor) = qmd_cli::system_executor() else {
        return Ok(QmdIndexReport::unavailable());
    };
    refresh_index_with(&executor, vault_path, collection)
}

fn refresh_index_with(
    executor: &dyn qmd_cli::QmdExecutor,
    vault_path: &str,
    collection: &str,
) -> Result<QmdIndexReport, String> {
    let expanded = expand_tilde(vault_path);
    let collection_created = qmd_cli::ensure_collection(executor, expanded.as_ref(), collection)?;
    qmd_cli::update_index(executor, collection)?;
    Ok(QmdIndexReport {
        available: true,
        collection_created,
        indexed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qmd_cli::{QmdExecutor, QmdOutput};
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// Test double replaying canned qmd outputs in call order.
    struct ScriptedExecutor {
        responses: RefCell<VecDeque<Result<QmdOutput, String>>>,
    }

    impl ScriptedExecutor {
        fn new(responses: Vec<Result<QmdOutput, String>>) -> Self {
            Self {
                responses: RefCell::new(responses.into()),
            }
        }
    }

    impl QmdExecutor for ScriptedExecutor {
        fn run(&self, _args: &[&str]) -> Result<QmdOutput, String> {
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

    #[test]
    fn memory_query_with_returns_available_hits() {
        let executor = ScriptedExecutor::new(vec![success(
            r#"[{"file": "qmd://memory/wiki/rust.md", "title": "Rust", "score": 0.8, "snippet": "Ownership"}]"#,
        )]);

        let response = memory_query_with(&executor, "ownership", "memory", 5).unwrap();

        assert!(response.available);
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].path, "wiki/rust.md");
    }

    #[test]
    fn memory_query_with_surfaces_query_failure() {
        let executor = ScriptedExecutor::new(vec![failure("no index")]);

        let error = memory_query_with(&executor, "ownership", "memory", 5).unwrap_err();

        assert!(error.contains("qmd query failed"));
    }

    #[test]
    fn refresh_index_with_registers_missing_collection_and_indexes() {
        let executor = ScriptedExecutor::new(vec![
            success("No collections found. Run 'qmd collection add .' to create one.\n"),
            success("Collection added"),
            success("Update command set"),
            success("updated"),
            success("embedded"),
        ]);

        let report = refresh_index_with(&executor, "/tmp/memory-vault", "memory").unwrap();

        assert!(report.available);
        assert!(report.collection_created);
        assert!(report.indexed);
    }

    #[test]
    fn refresh_index_with_skips_existing_collection() {
        let executor = ScriptedExecutor::new(vec![
            success("memory (qmd://memory/)\n"),
            success("updated"),
            success("embedded"),
        ]);

        let report = refresh_index_with(&executor, "/tmp/memory-vault", "memory").unwrap();

        assert!(report.available);
        assert!(!report.collection_created);
        assert!(report.indexed);
    }

    #[test]
    fn refresh_index_with_surfaces_update_failure() {
        let executor = ScriptedExecutor::new(vec![
            success("memory (qmd://memory/)\n"),
            failure("remote unreachable"),
        ]);

        let error = refresh_index_with(&executor, "/tmp/memory-vault", "memory").unwrap_err();

        assert!(error.contains("qmd update failed"));
    }

    #[tokio::test]
    async fn run_blocking_returns_task_value() {
        let value = run_blocking(|| 42).await.unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn query_response_serializes_camel_case() {
        let response = QmdQueryResponse {
            available: true,
            hits: vec![QmdHit {
                path: "wiki/rust.md".to_string(),
                title: "Rust".to_string(),
                score: 0.9,
                snippet: "Ownership".to_string(),
            }],
        };

        let json = serde_json::to_value(&response).unwrap();

        assert_eq!(json["available"], true);
        assert_eq!(json["hits"][0]["path"], "wiki/rust.md");
        assert_eq!(json["hits"][0]["snippet"], "Ownership");
    }

    #[test]
    fn index_report_serializes_camel_case() {
        let json = serde_json::to_value(QmdIndexReport::unavailable()).unwrap();

        assert_eq!(json["available"], false);
        assert_eq!(json["collectionCreated"], false);
        assert_eq!(json["indexed"], false);
    }

    #[test]
    fn unavailable_response_carries_no_hits() {
        let response = QmdQueryResponse::unavailable();
        assert!(!response.available);
        assert!(response.hits.is_empty());
    }
}
