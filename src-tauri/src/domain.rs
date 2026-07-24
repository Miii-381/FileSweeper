use std::collections::HashSet;

use super::{default_list_columns, ListColumn, Preferences};

pub(super) fn normalize_extensions(extensions: &mut Vec<String>) {
    *extensions = extensions
        .iter()
        .map(|extension| extension.trim().to_ascii_lowercase())
        .filter(|extension| !extension.is_empty())
        .map(|extension| {
            if extension.starts_with('.') {
                extension
            } else {
                format!(".{extension}")
            }
        })
        .collect();
    extensions.sort();
    extensions.dedup();
}

pub(super) fn normalize_extension_groups(settings: &mut Preferences) {
    normalize_extensions(&mut settings.video_extensions);
    normalize_extensions(&mut settings.image_extensions);
    normalize_extensions(&mut settings.text_extensions);
    let mut occupied = HashSet::new();
    settings
        .video_extensions
        .retain(|extension| occupied.insert(extension.clone()));
    settings
        .image_extensions
        .retain(|extension| occupied.insert(extension.clone()));
    settings
        .text_extensions
        .retain(|extension| occupied.insert(extension.clone()));
    settings.text_language_map.retain(|extension, language| {
        !extension.is_empty()
            && settings.text_extensions.contains(extension)
            && is_supported_prism_language(language)
    });
}

pub(super) fn is_supported_prism_language(language: &str) -> bool {
    matches!(
        language,
        "plain"
            | "markup"
            | "html"
            | "css"
            | "javascript"
            | "typescript"
            | "tsx"
            | "json"
            | "markdown"
            | "yaml"
            | "bash"
            | "powershell"
            | "sql"
            | "python"
            | "rust"
            | "java"
            | "c"
            | "cpp"
            | "go"
    )
}

pub(super) fn is_supported_code_theme(theme: &str) -> bool {
    matches!(
        theme,
        "default"
            | "dark"
            | "funky"
            | "okaidia"
            | "tomorrow"
            | "twilight"
            | "coy"
            | "solarizedlight"
    )
}

pub(super) fn normalize_list_columns(columns: &mut Vec<ListColumn>) {
    let defaults = default_list_columns();
    let allowed_columns: HashSet<&str> = defaults.iter().map(|column| column.id.as_str()).collect();
    let mut seen_columns = HashSet::new();
    let mut normalized: Vec<ListColumn> = columns
        .drain(..)
        .filter_map(|mut column| {
            if !allowed_columns.contains(column.id.as_str())
                || !seen_columns.insert(column.id.clone())
            {
                return None;
            }
            column.width = column.width.clamp(80, 520);
            if column.id == "name" {
                column.visible = true;
            }
            Some(column)
        })
        .collect();
    for column in defaults {
        if !seen_columns.contains(&column.id) {
            normalized.push(column);
        }
    }
    if let Some(name_index) = normalized.iter().position(|column| column.id == "name") {
        let name_column = normalized.remove(name_index);
        normalized.insert(0, name_column);
    }
    *columns = normalized;
}

pub(super) fn validate_windows_file_stem(new_stem: &str) -> Result<String, String> {
    let stem = new_stem.trim();
    if stem.is_empty() || stem.ends_with('.') || stem.ends_with(' ') {
        return Err("The new file name cannot be empty or end with a dot or space.".to_string());
    }
    if stem.len() > 240
        || stem.chars().any(|character| {
            matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        })
    {
        return Err(
            "The new file name contains characters that Windows does not allow.".to_string(),
        );
    }
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.iter().any(|name| stem.eq_ignore_ascii_case(name)) {
        return Err("The new file name is reserved by Windows.".to_string());
    }
    Ok(stem.to_string())
}

pub(super) fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub(super) fn thumbnail_capture_cache_key(position: &str) -> &'static str {
    match position {
        "opening" => "opening-1s-thumbnailer-v1",
        "early" => "early-thumbnailer-v1",
        "late" => "late-thumbnailer-v1",
        "ending" => "ending-thumbnailer-v1",
        _ => "middle-thumbnailer-v1",
    }
}

pub(super) fn is_supported_sort_key(key: &str) -> bool {
    matches!(
        key,
        "createdAt" | "modifiedAt" | "name" | "type" | "size" | "duration" | "resolution"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_normalized_sorted_and_deduplicated() {
        let mut extensions = vec![
            " MP4 ".to_string(),
            ".mkv".to_string(),
            ".MP4".to_string(),
            "".to_string(),
        ];
        normalize_extensions(&mut extensions);
        assert_eq!(extensions, vec![".mkv", ".mp4"]);
    }

    #[test]
    fn list_columns_keep_name_first_and_restore_defaults() {
        let mut columns = vec![
            ListColumn {
                id: "size".to_string(),
                visible: false,
                width: 12,
            },
            ListColumn {
                id: "name".to_string(),
                visible: false,
                width: 900,
            },
            ListColumn {
                id: "unknown".to_string(),
                visible: true,
                width: 100,
            },
        ];
        normalize_list_columns(&mut columns);
        assert_eq!(columns[0].id, "name");
        assert!(columns[0].visible);
        assert_eq!(columns[0].width, 520);
        assert_eq!(columns[1].id, "size");
        assert_eq!(columns[1].width, 80);
        assert_eq!(columns.len(), default_list_columns().len());
    }

    #[test]
    fn windows_file_stem_rules_cover_invalid_and_reserved_names() {
        assert!(validate_windows_file_stem("CON").is_err());
        assert!(validate_windows_file_stem("bad:name").is_err());
        assert!(validate_windows_file_stem("trailing.").is_err());
        assert_eq!(
            validate_windows_file_stem("  episode 01  ").unwrap(),
            "episode 01"
        );
    }

    #[test]
    fn thumbnail_cache_identity_changes_with_capture_position() {
        assert_ne!(
            thumbnail_capture_cache_key("opening"),
            thumbnail_capture_cache_key("middle")
        );
        assert_eq!(
            thumbnail_capture_cache_key("unknown"),
            "middle-thumbnailer-v1"
        );
    }

    #[test]
    fn fnv1a_matches_known_vector() {
        assert_eq!(fnv1a_64(b"hello"), 0xa430d84680aabd0b);
    }

    #[test]
    fn workspace_sort_keys_are_restricted_to_visible_options() {
        for key in ["createdAt", "name", "size", "duration", "resolution"] {
            assert!(is_supported_sort_key(key));
        }
        assert!(is_supported_sort_key("modifiedAt"));
        assert!(!is_supported_sort_key(""));
    }
}
