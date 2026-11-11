//! The YAML subset beta-life writes and Obsidian's Properties produce: scalars, lists, one level of map.

/// A frontmatter value. `Raw` is written unquoted (numbers, booleans); parsed values are never `Raw`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Val {
    Str(String),
    Raw(String),
    List(Vec<String>),
    Map(Vec<(String, String)>),
    /// Write-only nested map with typed values.
    Nested(Vec<(String, Val)>),
}

pub(crate) fn s(value: impl Into<String>) -> Val {
    Val::Str(value.into())
}

pub(crate) fn raw(value: impl ToString) -> Val {
    Val::Raw(value.to_string())
}

#[derive(Debug, Default)]
pub(crate) struct Front {
    fields: Vec<(String, Val)>,
}

impl Front {
    /// A scalar, or a list joined with `, ` (Obsidian may turn `tags` into a list).
    pub(crate) fn get(&self, key: &str) -> Option<String> {
        match self.value(key)? {
            Val::Str(value) | Val::Raw(value) => Some(value.clone()),
            Val::List(items) => Some(items.join(", ")),
            Val::Map(_) | Val::Nested(_) => None,
        }
    }

    /// `get` without empty values.
    pub(crate) fn text(&self, key: &str) -> Option<String> {
        self.get(key).filter(|value| !value.trim().is_empty())
    }

    pub(crate) fn map(&self, key: &str) -> Vec<(String, String)> {
        match self.value(key) {
            Some(Val::Map(entries)) => entries.clone(),
            _ => Vec::new(),
        }
    }

    fn value(&self, key: &str) -> Option<&Val> {
        self.fields.iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }
}

/// Splits a document into frontmatter and body (leading blank lines removed). A file without
/// frontmatter has an empty `Front`; an opening `---` that is never closed is an error.
pub(crate) fn parse(text: &str) -> Result<(Front, String), String> {
    let Some(rest) = text.strip_prefix("---\n") else {
        return Ok((Front::default(), text.trim_start_matches('\n').to_string()));
    };
    let mut header = Vec::new();
    let mut body = None;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let bare = line.trim_end_matches('\n').trim_end();
        if bare == "---" || bare == "..." {
            body = Some(&rest[offset..]);
            break;
        }
        header.push(line.trim_end_matches('\n'));
    }
    let body = body.ok_or("frontmatter 开头的 --- 没有对应的结束行")?;
    Ok((parse_fields(&header), body.trim_start_matches('\n').to_string()))
}

fn parse_fields(lines: &[&str]) -> Front {
    let mut fields: Vec<(String, Val)> = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let nested = line.starts_with([' ', '\t']) || trimmed.starts_with('-');
        if nested {
            let Some((_, value)) = fields.last_mut() else { continue };
            if let Some(item) = trimmed.strip_prefix('-') {
                let item = unquote(item.trim());
                match value {
                    Val::List(items) => items.push(item),
                    Val::Str(current) if current.is_empty() => *value = Val::List(vec![item]),
                    _ => {}
                }
            } else if let Some((key, item)) = trimmed.split_once(':') {
                let entry = (key.trim().to_string(), unquote(item.trim()));
                match value {
                    Val::Map(entries) => entries.push(entry),
                    Val::Str(current) if current.is_empty() => *value = Val::Map(vec![entry]),
                    _ => {}
                }
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        let parsed = if value.starts_with('[') && value.ends_with(']') {
            Val::List(
                value[1..value.len() - 1]
                    .split(',')
                    .map(|item| unquote(item.trim()))
                    .filter(|item| !item.is_empty())
                    .collect(),
            )
        } else {
            Val::Str(unquote(value))
        };
        fields.push((key.trim().to_string(), parsed));
    }
    Front { fields }
}

fn unquote(value: &str) -> String {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        serde_json::from_str(value).unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        value[1..value.len() - 1].replace("''", "'")
    } else {
        value.to_string()
    }
}

/// Plain when YAML would read the text back unchanged as a string, otherwise a JSON (= YAML) quoted string.
fn scalar(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let needs_quotes = value.is_empty()
        || value != value.trim()
        || value.contains(['\n', '\t'])
        || value.contains(": ")
        || value.ends_with(':')
        || value.contains(" #")
        || value.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`',
        ])
        || matches!(lower.as_str(), "true" | "false" | "yes" | "no" | "on" | "off" | "null" | "~")
        || value.parse::<f64>().is_ok();
    if needs_quotes {
        serde_json::to_string(value).unwrap_or_default()
    } else {
        value.to_string()
    }
}

/// `---` frontmatter, a blank line, then the body with one trailing newline.
pub(crate) fn render(fields: &[(&str, Val)], body: &str) -> String {
    let mut output = String::from("---\n");
    for (key, value) in fields {
        match value {
            Val::Str(text) => output.push_str(&format!("{key}: {}\n", scalar(text))),
            Val::Raw(text) => output.push_str(&format!("{key}: {text}\n")),
            Val::List(items) => {
                output.push_str(&format!("{key}:\n"));
                for item in items {
                    output.push_str(&format!("  - {}\n", scalar(item)));
                }
            }
            Val::Map(entries) => {
                output.push_str(&format!("{key}:\n"));
                for (name, item) in entries {
                    output.push_str(&format!("  {name}: {}\n", scalar(item)));
                }
            }
            Val::Nested(entries) => {
                output.push_str(&format!("{key}:\n"));
                for (name, item) in entries {
                    let text = match item {
                        Val::Raw(text) => text.clone(),
                        Val::Str(text) => scalar(text),
                        _ => String::new(),
                    };
                    output.push_str(&format!("  {name}: {text}\n"));
                }
            }
        }
    }
    output.push_str("---\n");
    let body = body.trim_end();
    if !body.is_empty() {
        output.push('\n');
        output.push_str(body);
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_values_that_need_quotes() {
        let values = [
            "听息/静坐+AI信息输入习惯",
            "- 睡前双脚放松\n- 睡前唱歌",
            "a: b",
            "#F59E0B",
            "20220102",
            "true",
            "",
            " 前后空格 ",
            "说 \"引号\"",
        ];
        let fields: Vec<(&str, Val)> = values.iter().enumerate().map(|(index, value)| {
            (["a", "b", "c", "d", "e", "f", "g", "h", "i"][index], s(*value))
        }).collect();
        let (front, body) = parse(&render(&fields, "正文")).unwrap();
        for (index, value) in values.iter().enumerate() {
            assert_eq!(front.get(fields[index].0).as_deref(), Some(*value));
        }
        assert_eq!(body, "正文\n");
    }

    #[test]
    fn reads_obsidian_lists_maps_and_missing_frontmatter() {
        let text = "---\ntags:\n  - 推荐系统\n  - 算法\naliases: [x, 'y''s']\nemotion:\n  type: calm\n  intensity: 7\n---\n\n正文";
        let (front, body) = parse(text).unwrap();
        assert_eq!(front.get("tags").as_deref(), Some("推荐系统, 算法"));
        assert_eq!(front.get("aliases").as_deref(), Some("x, y's"));
        assert_eq!(front.map("emotion"), vec![("type".into(), "calm".into()), ("intensity".into(), "7".into())]);
        assert_eq!(body, "正文");
        let (front, body) = parse("没有头部").unwrap();
        assert!(front.get("id").is_none());
        assert_eq!(body, "没有头部");
        assert!(parse("---\nid: x\n正文").is_err());
    }
}
