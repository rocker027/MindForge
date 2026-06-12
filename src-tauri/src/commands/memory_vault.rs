use serde::Serialize;
use std::path::Path;

use crate::commands::expand_tilde;
use crate::git;
use crate::vault_list::{self, VaultEntry, VaultList, MEMORY_VAULT_KIND};

const DATE_PLACEHOLDER: &str = "{{DATE}}";
const TEMPLATE_DIRS: &[&str] = &["raw/inbox", "raw/assets", "wiki"];

struct TemplateFile {
    relative_path: &'static str,
    content: &'static str,
}

macro_rules! template_file {
    ($relative_path:literal) => {
        TemplateFile {
            relative_path: $relative_path,
            content: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/memory-vault-template/",
                $relative_path
            )),
        }
    };
}

/// Files copied verbatim from `resources/memory-vault-template/`, except for
/// the `{{DATE}}` placeholder which is rendered at scaffold time.
const TEMPLATE_FILES: &[TemplateFile] = &[
    template_file!("AGENTS.md"),
    template_file!("CLAUDE.md"),
    template_file!(".gitignore"),
    template_file!("wiki/index.md"),
    template_file!("wiki/log.md"),
    template_file!("wiki/overview.md"),
    template_file!("raw/inbox/.gitkeep"),
    template_file!("raw/assets/.gitkeep"),
];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryVaultScaffoldReport {
    pub path: String,
    pub created_files: Vec<String>,
    pub skipped_files: Vec<String>,
    pub git_initialized: bool,
    pub registered: bool,
}

/// Scaffold a memory vault from the bundled template and mount it.
///
/// Idempotent: existing files are never overwritten, an existing git repo is
/// left untouched, and an already-registered path is not duplicated in
/// `vaults.json`.
#[tauri::command]
pub fn scaffold_memory_vault(path: String) -> Result<MemoryVaultScaffoldReport, String> {
    let expanded = expand_tilde(&path).into_owned();
    let root = Path::new(&expanded);

    let (created_files, skipped_files) = scaffold_template_files(root, &today_date())?;
    let git_initialized = ensure_git_repo(root)?;
    let canonical_path = canonical_path_string(root);
    let registered = register_in_vault_list(&canonical_path)?;

    Ok(MemoryVaultScaffoldReport {
        path: canonical_path,
        created_files,
        skipped_files,
        git_initialized,
        registered,
    })
}

fn scaffold_template_files(root: &Path, date: &str) -> Result<(Vec<String>, Vec<String>), String> {
    create_template_directories(root)?;

    let mut created = Vec::new();
    let mut skipped = Vec::new();
    for file in TEMPLATE_FILES {
        let target = root.join(file.relative_path);
        if target.exists() {
            skipped.push(file.relative_path.to_string());
            continue;
        }
        let content = file.content.replace(DATE_PLACEHOLDER, date);
        std::fs::write(&target, content)
            .map_err(|e| format!("Failed to write {}: {e}", file.relative_path))?;
        created.push(file.relative_path.to_string());
    }
    Ok((created, skipped))
}

fn create_template_directories(root: &Path) -> Result<(), String> {
    for dir in TEMPLATE_DIRS {
        std::fs::create_dir_all(root.join(dir))
            .map_err(|e| format!("Failed to create {dir}: {e}"))?;
    }
    Ok(())
}

/// Initialize git in `root` unless it already is a repository.
/// Returns whether a new repository was created.
fn ensure_git_repo(root: &Path) -> Result<bool, String> {
    if root.join(".git").is_dir() {
        return Ok(false);
    }
    git::init_repo(root)?;
    Ok(true)
}

fn register_in_vault_list(path: &str) -> Result<bool, String> {
    let mut list = vault_list::load_vault_list()?;
    let registered = register_memory_vault(&mut list, path);
    if registered {
        vault_list::save_vault_list(&list)?;
    }
    Ok(registered)
}

/// Add a mounted memory-vault entry unless the path is already registered.
/// Returns whether the list was modified.
fn register_memory_vault(list: &mut VaultList, path: &str) -> bool {
    if list.vaults.iter().any(|vault| vault.path == path) {
        return false;
    }
    list.vaults.push(VaultEntry {
        label: memory_vault_label(Path::new(path)),
        path: path.to_string(),
        mounted: Some(true),
        kind: MEMORY_VAULT_KIND.to_string(),
        ..VaultEntry::default()
    });
    true
}

fn memory_vault_label(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "Memory".to_string())
}

fn today_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn canonical_path_string(root: &Path) -> String {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_TEMPLATE_PATHS: &[&str] = &[
        "AGENTS.md",
        "CLAUDE.md",
        ".gitignore",
        "wiki/index.md",
        "wiki/log.md",
        "wiki/overview.md",
        "raw/inbox/.gitkeep",
        "raw/assets/.gitkeep",
    ];

    fn scaffolded_tempdir(date: &str) -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        scaffold_template_files(dir.path(), date).unwrap();
        dir
    }

    #[test]
    fn scaffold_creates_template_structure() {
        let dir = tempfile::TempDir::new().unwrap();

        let (created, skipped) = scaffold_template_files(dir.path(), "2026-06-12").unwrap();

        assert_eq!(created.len(), EXPECTED_TEMPLATE_PATHS.len());
        assert!(skipped.is_empty());
        for path in EXPECTED_TEMPLATE_PATHS {
            assert!(dir.path().join(path).is_file(), "{path} should exist");
        }
    }

    #[test]
    fn scaffold_replaces_date_placeholder_in_log() {
        let dir = scaffolded_tempdir("2026-06-12");

        let log = std::fs::read_to_string(dir.path().join("wiki/log.md")).unwrap();

        assert!(log.contains("## [2026-06-12] init | Memory vault scaffolded"));
        assert!(!log.contains(DATE_PLACEHOLDER));
    }

    #[test]
    fn scaffold_is_idempotent_and_preserves_existing_files() {
        let dir = scaffolded_tempdir("2026-06-12");
        let index_path = dir.path().join("wiki/index.md");
        std::fs::write(&index_path, "user edited").unwrap();

        let (created, skipped) = scaffold_template_files(dir.path(), "2026-06-13").unwrap();

        assert!(created.is_empty());
        assert_eq!(skipped.len(), EXPECTED_TEMPLATE_PATHS.len());
        assert_eq!(std::fs::read_to_string(&index_path).unwrap(), "user edited");
    }

    #[test]
    fn ensure_git_repo_initializes_once_and_keeps_template_gitignore() {
        let dir = scaffolded_tempdir("2026-06-12");
        let template_gitignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();

        assert!(ensure_git_repo(dir.path()).unwrap());
        assert!(dir.path().join(".git").is_dir());
        assert!(!ensure_git_repo(dir.path()).unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            template_gitignore,
            "git init must not replace the template .gitignore"
        );
    }

    #[test]
    fn register_memory_vault_adds_mounted_memory_entry_once() {
        let mut list = VaultList::default();

        assert!(register_memory_vault(&mut list, "/tmp/memory-vault"));
        assert!(!register_memory_vault(&mut list, "/tmp/memory-vault"));

        assert_eq!(list.vaults.len(), 1);
        let entry = &list.vaults[0];
        assert_eq!(entry.kind, MEMORY_VAULT_KIND);
        assert_eq!(entry.mounted, Some(true));
        assert_eq!(entry.label, "memory-vault");
    }

    #[test]
    fn register_memory_vault_keeps_existing_entries_untouched() {
        let mut list = VaultList {
            vaults: vec![VaultEntry {
                label: "Notes".to_string(),
                path: "/tmp/notes".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };

        assert!(register_memory_vault(&mut list, "/tmp/memory-vault"));

        assert_eq!(list.vaults.len(), 2);
        assert_eq!(list.vaults[0].label, "Notes");
        assert_eq!(list.vaults[0].kind, vault_list::NOTES_VAULT_KIND);
    }

    #[test]
    fn today_date_uses_iso_format() {
        let date = today_date();
        assert_eq!(date.len(), 10);
        assert_eq!(date.as_bytes()[4], b'-');
        assert_eq!(date.as_bytes()[7], b'-');
    }
}
