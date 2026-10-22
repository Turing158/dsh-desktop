//! Export filtering. Unknown child output is never part of the default report.
use serde_json::Value;

fn sensitive(key: &str) -> bool {
    let key: String = key.chars().filter(|c| c.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect();
    ["token", "cookie", "authorization", "apikey", "password", "secret", "credential", "email", "username", "body", "message", "prompt", "content", "details", "hint"].iter().any(|part| key.contains(part))
}

/// Reports use symbolic paths and discard free text rather than guessing whether
/// chat content or a secret happens to look like an error message.
pub fn report(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if sensitive(key) || key.to_ascii_lowercase().contains("path") || key.to_ascii_lowercase().contains("directory") || key == "entry" || key == "dataRoot" || key == "profileHome" || key == "appDataRoot" {
                    *value = Value::String("[omitted]".into());
                } else { report(value); }
            }
        }
        Value::Array(rows) => rows.iter_mut().for_each(report),
        Value::String(text) => {
            if text.contains("://") || text.contains('@') || text.contains('\\') || text.contains('/') || text.contains("sk-") || text.contains("Bearer ") {
                *text = "[omitted]".into();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_credentials_paths_and_unstructured_text_are_not_exported() {
        let mut value = serde_json::json!({"apiKey":"sk-test", "details":{"Cookie":"secret", "body":"private chat", "nodePath":"C:\\Users\\Alice\\node.exe"}, "url":"http://localhost/?token=abc", "label":"alice@example.org", "availability":"unknown", "reasonCodes":["storage-unverified"]});
        report(&mut value);
        let out = value.to_string();
        for private in ["sk-test", "secret", "private chat", "Alice", "token=abc", "alice@example"] { assert!(!out.contains(private), "{out}"); }
        assert_eq!(value["availability"], "unknown");
        assert_eq!(value["reasonCodes"][0], "storage-unverified");
    }
}
