//! Validates that the bundled memory-vault-template scaffold parses with
//! Tolaria's existing frontmatter, title, and wikilink machinery.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn template_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/memory-vault-template")
}

fn parse_template_file(relative: &str) -> VaultEntry {
    let path = template_root().join(relative);
    parse_md_file(&path, None)
        .unwrap_or_else(|err| panic!("failed to parse template file {relative}: {err}"))
}

#[test]
fn test_template_scaffold_files_exist() {
    let expected = [
        "AGENTS.md",
        "CLAUDE.md",
        ".gitignore",
        "wiki/index.md",
        "wiki/log.md",
        "wiki/overview.md",
        "raw/inbox/.gitkeep",
        "raw/assets/.gitkeep",
    ];
    for relative in expected {
        assert!(
            template_root().join(relative).is_file(),
            "missing template file: {relative}"
        );
    }
}

#[test]
fn test_template_wiki_pages_parse_as_wiki_type_with_h1_titles() {
    let pages = [
        ("wiki/index.md", "Index"),
        ("wiki/log.md", "Log"),
        ("wiki/overview.md", "Overview"),
    ];
    for (relative, expected_title) in pages {
        let entry = parse_template_file(relative);
        assert_eq!(entry.is_a.as_deref(), Some("Wiki"), "type of {relative}");
        assert_eq!(entry.title, expected_title, "title of {relative}");
        assert!(entry.has_h1, "{relative} must start with an H1");
    }
}

#[test]
fn test_template_index_links_to_overview() {
    let entry = parse_template_file("wiki/index.md");
    assert!(
        entry.outgoing_links.contains(&"overview".to_string()),
        "index.md must wikilink the overview page, got: {:?}",
        entry.outgoing_links
    );
}

#[test]
fn test_template_log_contains_scaffold_init_entry() {
    let content = fs::read_to_string(template_root().join("wiki/log.md")).unwrap();
    assert!(
        content.contains("## [{{DATE}}] init | "),
        "log.md must contain the scaffold init entry with a date placeholder"
    );
}

#[test]
fn test_template_claude_md_is_agents_shim() {
    let content = fs::read_to_string(template_root().join("CLAUDE.md")).unwrap();
    assert!(
        content.contains("@AGENTS.md"),
        "CLAUDE.md must reference @AGENTS.md"
    );
}

/// The wiki page format documented in the template AGENTS.md must round-trip
/// through Tolaria's parser: `type: Wiki` resolves the entity type, `sources:`
/// surfaces as a scalar-array property, and quoted `"[[wikilink]]"` list items
/// register as relationships (ADR-0010 dynamic detection).
#[test]
fn test_documented_wiki_page_format_parses_into_tolaria_model() {
    let dir = TempDir::new().unwrap();
    let content = "---\n\
                   type: Wiki\n\
                   sources:\n  \
                   - raw/2026-06-01-kickoff-notes.md\n  \
                   - raw/2026-06-12-conference-notes.md\n\
                   related_to:\n  \
                   - \"[[vector-search]]\"\n\
                   ---\n\
                   # Acme Corp\n\n\
                   B2B SaaS client (source: raw/2026-06-01-kickoff-notes.md). See [[vector-search]].\n";
    let path = dir.path().join("acme-corp.md");
    fs::write(&path, content).unwrap();
    let entry = parse_md_file(&path, None).unwrap();

    assert_eq!(entry.is_a.as_deref(), Some("Wiki"));
    assert_eq!(entry.title, "Acme Corp");
    assert_eq!(entry.related_to, vec!["[[vector-search]]".to_string()]);
    assert_eq!(
        entry.relationships.get("related_to"),
        Some(&vec!["[[vector-search]]".to_string()])
    );
    let sources = entry
        .properties
        .get("sources")
        .and_then(|value| value.as_array())
        .expect("sources must surface as a scalar-array property");
    assert_eq!(sources.len(), 2);
    assert!(entry.outgoing_links.contains(&"vector-search".to_string()));
}
