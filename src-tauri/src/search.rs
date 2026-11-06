//! 全库正文检索的文本处理：为 FTS5 生成中英混排 token，并从原文里截取命中片段。
//!
//! 中文没有空格，`unicode61` 会把整句当成一个词。索引时 CJK 连续段同时产出
//! 单字与二元组，查询时用二元组（单字保留单字）：单字查询也能走 FTS，不必
//! 回退到全表 LIKE。拉丁字母/数字切成小写单词，查询时英文词放宽成前缀匹配。

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x30FF     // 日文假名
        | 0x3400..=0x4DBF   // CJK 扩展 A
        | 0x4E00..=0x9FFF   // CJK 基本区
        | 0xAC00..=0xD7AF   // 韩文音节
        | 0xF900..=0xFAFF   // CJK 兼容区
        | 0x20000..=0x2FA1F // CJK 扩展 B 及以后
    )
}

/// 索引用：单字 + 二元组。单字让「的」「科」这类查询能走索引；
/// 二元组保持「认知科学」这类连续短语的匹配语义。
fn flush_cjk_index(cjk: &mut Vec<char>, tokens: &mut Vec<String>) {
    for ch in cjk.iter() {
        tokens.push(ch.to_string());
    }
    for window in cjk.windows(2) {
        tokens.push(window.iter().collect());
    }
    cjk.clear();
}

/// 查询用：连续中文切成二元组；只有一个字时保留单字（索引里有单字）。
fn flush_cjk_query(cjk: &mut Vec<char>, tokens: &mut Vec<String>) {
    if cjk.len() == 1 {
        tokens.push(cjk[0].to_string());
    } else {
        for window in cjk.windows(2) {
            tokens.push(window.iter().collect());
        }
    }
    cjk.clear();
}

fn flush_word(word: &mut String, tokens: &mut Vec<String>) {
    if !word.is_empty() {
        tokens.push(word.to_lowercase());
        word.clear();
    }
}

/// 建索引用：CJK 连续段产出单字与二元组，拉丁字母/数字切成小写单词。
pub fn tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cjk: Vec<char> = Vec::new();
    let mut word = String::new();

    for ch in text.chars() {
        if is_cjk(ch) {
            flush_word(&mut word, &mut tokens);
            cjk.push(ch);
        } else if ch.is_alphanumeric() {
            flush_cjk_index(&mut cjk, &mut tokens);
            word.push(ch);
        } else {
            flush_cjk_index(&mut cjk, &mut tokens);
            flush_word(&mut word, &mut tokens);
        }
    }
    flush_cjk_index(&mut cjk, &mut tokens);
    flush_word(&mut word, &mut tokens);
    tokens
}

/// 查询用：与索引里的二元组对应；单字词保留单字，直接命中索引里的单字。
pub fn query_tokens(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cjk: Vec<char> = Vec::new();
    let mut word = String::new();

    for ch in query.chars() {
        if is_cjk(ch) {
            flush_word(&mut word, &mut tokens);
            cjk.push(ch);
        } else if ch.is_alphanumeric() {
            flush_cjk_query(&mut cjk, &mut tokens);
            word.push(ch);
        } else {
            flush_cjk_query(&mut cjk, &mut tokens);
            flush_word(&mut word, &mut tokens);
        }
    }
    flush_cjk_query(&mut cjk, &mut tokens);
    flush_word(&mut word, &mut tokens);
    tokens
}

/// 把查询转换成 FTS5 MATCH 表达式；英文词加 `*` 支持前缀，中文二元组精确匹配。
pub fn match_query(query: &str) -> Option<String> {
    let trimmed = query.trim();
    let tokens = query_tokens(trimmed);
    if tokens.is_empty() {
        return None;
    }

    let has_latin = tokens
        .iter()
        .any(|token| token.chars().all(|ch| ch.is_ascii_alphanumeric()));
    // 空格、标点都会把查询拆成多个词；只有一整段连续中文才按短语匹配，
    // 否则「人，物」会被当成相邻的两个字，永远匹配不到「人与物」。
    let has_separator = trimmed
        .chars()
        .any(|ch| !is_cjk(ch) && !ch.is_alphanumeric());
    if !has_latin && !has_separator {
        // 连续中文按二元组短语匹配，避免「认知」和「科学」分散在同一页也被当成命中。
        return Some(format!("\"{}\"", tokens.join(" ")));
    }

    let parts: Vec<String> = tokens
        .into_iter()
        .map(|token| {
            if token.chars().all(|ch| ch.is_ascii_alphanumeric()) {
                format!("{token}*")
            } else {
                token
            }
        })
        .collect();
    Some(parts.join(" "))
}

fn truncate_chars(text: &str, limit: usize) -> String {
    let mut out: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        out.push('…');
    }
    out.replace('\n', " ")
}

/// 在原文里找第一个查询词，截取前后窗口；找不到就返回开头一段。
pub fn snippet(text: &str, query: &str) -> String {
    const BEFORE: usize = 50;
    const AFTER: usize = 90;

    let mut terms: Vec<String> = vec![query.trim().to_lowercase()];
    terms.extend(query_tokens(query));

    // 建立小写副本到原文字符位置的映射，避免 to_lowercase 改变字节长度后切错位置。
    let mut lower = String::new();
    let mut origin: Vec<usize> = Vec::new();
    for (index, ch) in text.chars().enumerate() {
        for lowered in ch.to_lowercase() {
            lower.push(lowered);
            origin.push(index);
        }
    }

    let mut found: Option<usize> = None;
    for term in terms {
        if term.is_empty() {
            continue;
        }
        if let Some(byte_pos) = lower.find(&term) {
            let lowered_index = lower[..byte_pos].chars().count();
            found = origin.get(lowered_index).copied();
            break;
        }
    }

    let Some(position) = found else {
        return truncate_chars(text, BEFORE + AFTER);
    };

    let total = text.chars().count();
    let start = position.saturating_sub(BEFORE);
    let end = (position + AFTER).min(total);
    let mut out: String = text.chars().skip(start).take(end - start).collect();
    out = out.replace('\n', " ");
    if start > 0 {
        out.insert(0, '…');
    }
    if end < total {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_cjk_unigrams_bigrams_and_latin_words() {
        let tokens = tokens("认知科学 Cognitive Science 2026");
        assert!(tokens.contains(&"认".to_string()));
        assert!(tokens.contains(&"认知".to_string()));
        assert!(tokens.contains(&"知科".to_string()));
        assert!(tokens.contains(&"科学".to_string()));
        assert!(tokens.contains(&"cognitive".to_string()));
        assert!(tokens.contains(&"science".to_string()));
        assert!(tokens.contains(&"2026".to_string()));
        assert!(!tokens.contains(&"认知科学".to_string()));
    }

    #[test]
    fn query_tokens_use_bigrams_and_keep_single_cjk() {
        assert_eq!(query_tokens("认知科学"), vec!["认知", "知科", "科学"]);
        assert_eq!(query_tokens("人"), vec!["人"]);
        assert_eq!(query_tokens("AI标注"), vec!["ai", "标注"]);
        assert_eq!(query_tokens("我 认知"), vec!["我", "认知"]);
    }

    #[test]
    fn builds_prefix_query_for_latin_and_phrase_for_cjk() {
        assert_eq!(match_query("annot"), Some("annot*".to_string()));
        assert_eq!(match_query("的"), Some("\"的\"".to_string()));
        assert_eq!(match_query("认知"), Some("\"认知\"".to_string()));
        assert_eq!(
            match_query("认知科学"),
            Some("\"认知 知科 科学\"".to_string())
        );
        assert_eq!(match_query("AI 标注"), Some("ai* 标注".to_string()));
        // 标点分隔的词必须按 AND 匹配；拼成短语会要求「人」「物」相邻。
        assert_eq!(match_query("人，物"), Some("人 物".to_string()));
        assert_eq!(match_query("我 认知"), Some("我 认知".to_string()));
        assert_eq!(match_query("   "), None);
    }

    #[test]
    fn snippet_finds_case_insensitive_terms_and_marks_edges() {
        let text = "第一段内容。\nAnnotating is the heart of the reader, and 认知科学 explains why. 最后一段。";
        let ascii = snippet(text, "annotating");
        assert!(ascii.contains("Annotating is the heart"));
        assert!(!ascii.contains('\n'));

        let cjk = snippet(text, "认知");
        assert!(cjk.contains("认知科学"));
        assert!(!cjk.contains('\n'));
    }

    #[test]
    fn snippet_falls_back_to_the_start() {
        let text = "这句话里没有查询词，但也要能展示一点上下文。";
        let out = snippet(text, "不存在");
        assert!(out.starts_with("这句话里"));
    }
}
