//! AI 阅读助手：解释选段、基于文档/标注的可溯源问答与总结。
//! 默认关闭；只有用户开启并主动点击时才会发出网络请求。

use crate::{
    db,
    models::{
        AiAnswer, AiCitation, AiSettingsInput, AiSettingsView, ChatTurn, Chunk, PageTextInput,
    },
    settings::{self, AiSettings},
    state::AppState,
};
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_CONTEXT_CHARS: usize = 12_000;
const MAX_SOURCE_CHARS: usize = 1_200;
const MAX_CHUNKS: usize = 20_000;

const SYSTEM_PROMPT: &str = "你是 GlossNote 的阅读助手。只依据提供的「资料」回答；资料不足时直接说明，不要编造。引用资料时在句末使用 [1] 这样的编号，编号必须来自资料列表。用简洁、清楚的中文回答。";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn settings_view(app: &AppHandle) -> AiSettingsView {
    let ai = settings::load(app).ai;
    let ready = ai.enabled && (ai.provider == "openai" || !ai.api_key.trim().is_empty());
    AiSettingsView {
        enabled: ai.enabled,
        provider: ai.provider,
        model: ai.model,
        base_url: ai.base_url,
        api_key_set: !ai.api_key.trim().is_empty(),
        ready,
    }
}

pub fn get_settings(app: &AppHandle) -> AiSettingsView {
    settings_view(app)
}

pub fn save_settings(app: &AppHandle, input: AiSettingsInput) -> Result<AiSettingsView, String> {
    let provider = match input.provider.trim() {
        "anthropic" | "openai" => input.provider.trim().to_string(),
        _ => return Err("AI 服务商只能是 anthropic 或 openai".to_string()),
    };
    let model = input.model.trim();
    if model.is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("API 地址不能为空".to_string());
    }

    let mut app_settings = settings::load(app);
    app_settings.ai.enabled = input.enabled;
    app_settings.ai.provider = provider;
    app_settings.ai.model = model.to_string();
    app_settings.ai.base_url = base_url;

    if input.clear_key {
        app_settings.ai.api_key.clear();
    } else if let Some(key) = input.api_key.filter(|value| !value.trim().is_empty()) {
        app_settings.ai.api_key = key.trim().to_string();
    }

    settings::save(app, &app_settings)?;
    Ok(settings_view(app))
}

#[derive(Deserialize)]
struct AnthropicBlock {
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    #[serde(default)]
    content: Vec<AnthropicBlock>,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
}

fn truncate(value: &str, limit: usize) -> String {
    let mut result: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        result.push('…');
    }
    result
}

fn http_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = body.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("AI 请求失败（HTTP {status}）：{}", truncate(&detail, 300))
}

async fn complete(settings: &AiSettings, system: &str, user: &str) -> Result<String, String> {
    if !settings.enabled {
        return Err("AI 尚未启用，请先在 AI 设置中开启".to_string());
    }
    let base = settings.base_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("创建 AI 客户端失败：{error}"))?;

    let text = if settings.provider == "anthropic" {
        if settings.api_key.trim().is_empty() {
            return Err("请先填写 Anthropic API Key".to_string());
        }
        let url = if base.ends_with("/messages") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/messages")
        } else {
            format!("{base}/v1/messages")
        };
        let body = serde_json::json!({
            "model": &settings.model,
            "max_tokens": 1400,
            "system": system,
            "messages": [{ "role": "user", "content": user }]
        });
        let response = client
            .post(url)
            .header("x-api-key", settings.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("连接 Anthropic 失败：{error}"))?;
        let status = response.status();
        let raw = response
            .text()
            .await
            .map_err(|error| format!("读取 AI 响应失败：{error}"))?;
        if !status.is_success() {
            return Err(http_error(status, &raw));
        }
        let parsed: AnthropicResponse =
            serde_json::from_str(&raw).map_err(|error| format!("解析 AI 响应失败：{error}"))?;
        parsed
            .content
            .iter()
            .filter_map(|block| block.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n")
    } else if settings.provider == "openai" {
        let url = if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        };
        let body = serde_json::json!({
            "model": &settings.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });
        let mut request = client.post(url).json(&body);
        if !settings.api_key.trim().is_empty() {
            request = request.bearer_auth(settings.api_key.trim());
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("连接 OpenAI 兼容服务失败：{error}"))?;
        let status = response.status();
        let raw = response
            .text()
            .await
            .map_err(|error| format!("读取 AI 响应失败：{error}"))?;
        if !status.is_success() {
            return Err(http_error(status, &raw));
        }
        let parsed: OpenAiResponse =
            serde_json::from_str(&raw).map_err(|error| format!("解析 AI 响应失败：{error}"))?;
        parsed
            .choices
            .first()
            .and_then(|choice| choice.message.content.clone())
            .unwrap_or_default()
    } else {
        return Err("未知的 AI 服务商".to_string());
    };

    if text.trim().is_empty() {
        return Err("AI 返回了空内容".to_string());
    }
    Ok(text)
}

pub async fn test(app: &AppHandle) -> Result<String, String> {
    let ai = settings::load(app).ai;
    complete(&ai, "你是连接测试助手。", "请只回复 OK。")
        .await
        .map(|text| text.trim().to_string())
}

fn query_terms(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut terms: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut cjk: Vec<char> = Vec::new();

    fn flush_word(word: &mut String, terms: &mut Vec<String>) {
        if word.chars().count() >= 2 {
            terms.push(word.clone());
        }
        word.clear();
    }

    fn flush_cjk(cjk: &mut Vec<char>, terms: &mut Vec<String>) {
        if cjk.len() == 1 {
            terms.push(cjk[0].to_string());
        } else {
            for pair in cjk.windows(2) {
                terms.push(pair.iter().collect());
            }
        }
        cjk.clear();
    }

    for ch in lower.chars() {
        let is_cjk = ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if is_cjk {
            flush_word(&mut word, &mut terms);
            cjk.push(ch);
        } else if ch.is_alphanumeric() {
            flush_cjk(&mut cjk, &mut terms);
            word.push(ch);
        } else {
            flush_word(&mut word, &mut terms);
            flush_cjk(&mut cjk, &mut terms);
        }
    }
    flush_word(&mut word, &mut terms);
    flush_cjk(&mut cjk, &mut terms);

    terms.sort();
    terms.dedup();
    terms
}

fn score_text(text: &str, terms: &[String], exact: Option<&str>) -> f64 {
    if terms.is_empty() {
        return 0.0;
    }

    let lower = text.to_lowercase();
    let mut score = 0.0;
    for term in terms {
        let count = lower.matches(term).count().min(3);
        if count > 0 {
            score += count as f64 * (1.0 + term.chars().count() as f64 * 0.1);
        }
    }
    if let Some(exact) = exact {
        if !exact.is_empty() && lower.contains(exact) {
            score += 6.0;
        }
    }
    score / (1.0 + (text.chars().count() as f64 / 2000.0)).sqrt()
}

struct Source {
    page: Option<u32>,
    kind: String,
    label: String,
    body: String,
    annotation_id: Option<String>,
    score: f64,
}

fn citation_for(index: usize, source: &Source) -> AiCitation {
    AiCitation {
        index,
        page: source.page,
        kind: source.kind.clone(),
        label: source.label.clone(),
        snippet: truncate(&source.body.replace('\n', " "), 240),
        annotation_id: source.annotation_id.clone(),
    }
}

/// 追问时把最近几轮对话拼进提示词；只保留短上下文，避免把整段历史都发出去。
fn history_block(history: &[ChatTurn]) -> String {
    let start = history.len().saturating_sub(8);
    let mut block = String::new();
    for turn in &history[start..] {
        let content = turn.content.trim();
        if content.is_empty() {
            continue;
        }
        let label = if turn.role == "assistant" {
            "助手"
        } else {
            "用户"
        };
        block.push_str(&format!("{label}：{}\n", truncate(content, 2_000)));
    }
    if block.is_empty() {
        String::new()
    } else {
        format!("\n\n之前的对话（保持上下文连贯，不要重复已经说过的内容）：\n{block}")
    }
}

fn build_prompt(question: &str, sources: &[Source]) -> String {
    let mut prompt = String::from("资料：\n");
    for (index, source) in sources.iter().enumerate() {
        prompt.push_str(&format!(
            "[{}]（{}）\n{}\n\n",
            index + 1,
            source.label,
            truncate(&source.body, MAX_SOURCE_CHARS)
        ));
    }
    prompt.push_str(&format!(
        "问题：{question}\n\n请用中文回答，并在引用处标注 [编号]。"
    ));
    prompt
}

fn select_sources(
    mut sources: Vec<Source>,
    max_chunks: usize,
    max_annotations: usize,
) -> Vec<Source> {
    sources.retain(|source| !source.body.trim().is_empty());
    sources.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let limit = max_chunks + max_annotations;
    let mut selected: Vec<Source> = Vec::new();
    let mut chunks = 0;
    let mut annotations = 0;
    let mut used_chars = 0;

    for source in sources {
        let is_annotation = source.kind == "annotation";
        if is_annotation && annotations >= max_annotations {
            continue;
        }
        if !is_annotation && chunks >= max_chunks {
            continue;
        }
        let cost = source.body.chars().count().min(MAX_SOURCE_CHARS);
        if used_chars + cost > MAX_CONTEXT_CHARS {
            continue;
        }
        used_chars += cost;
        if is_annotation {
            annotations += 1;
        } else {
            chunks += 1;
        }
        selected.push(source);
        if selected.len() >= limit {
            break;
        }
    }

    selected
}

fn doc_name(conn: &rusqlite::Connection, doc_id: &str) -> Result<String, String> {
    db::find_by_id(conn, doc_id)?
        .map(|document| document.name)
        .ok_or_else(|| "文档不存在".to_string())
}

/// 前端用 pdf.js 提取页面文字后写入本地索引；这一步不联网。
pub fn index_document_text(
    app: &AppHandle,
    doc_id: &str,
    pages: Vec<PageTextInput>,
) -> Result<usize, String> {
    let state = app.state::<AppState>();
    let mut conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if db::find_by_id(&conn, doc_id)?.is_none() {
        return Err("文档不存在".to_string());
    }

    let mut chunks = Vec::new();
    for input in &pages {
        for (index, text) in chunk_text(&input.text).into_iter().enumerate() {
            chunks.push(Chunk {
                id: format!("{doc_id}:{}:{index}", input.page),
                doc_id: doc_id.to_string(),
                page: input.page,
                text,
            });
        }
        if chunks.len() > MAX_CHUNKS {
            return Err("文档文字太多，暂时无法建立全文索引".to_string());
        }
    }

    db::replace_chunks(&mut conn, doc_id, &chunks, now_ms())
}

pub fn index_status(app: &AppHandle, doc_id: &str) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::is_text_indexed(&conn, doc_id)
}

fn chunk_text(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 900 {
        return vec![trimmed.to_string()];
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let hard_end = (start + 900).min(chars.len());
        let mut end = hard_end;
        if hard_end < chars.len() {
            for index in (start + 450..hard_end).rev() {
                if matches!(chars[index], '\n' | '。' | '！' | '？' | '.' | '!' | '?') {
                    end = index + 1;
                    break;
                }
            }
        }

        let chunk: String = chars[start..end].iter().collect();
        if !chunk.trim().is_empty() {
            chunks.push(chunk.trim().to_string());
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(120).max(start + 1);
    }
    chunks
}

pub async fn explain(
    app: &AppHandle,
    doc_id: &str,
    page: u32,
    quote: String,
    context: String,
) -> Result<AiAnswer, String> {
    let quote = quote.trim().to_string();
    if quote.is_empty() {
        return Err("没有选中的文字".to_string());
    }

    let ai = settings::load(app).ai;
    let title = {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        doc_name(&conn, doc_id)?
    };

    let source = Source {
        page: Some(page),
        kind: "page".to_string(),
        label: format!("《{title}》第 {} 页", page + 1),
        body: format!(
            "选段：\n{quote}\n\n上下文：\n{}",
            truncate(context.trim(), 2400)
        ),
        annotation_id: None,
        score: 1.0,
    };

    let sources = select_sources(vec![source], 1, 0);
    let citations = sources
        .iter()
        .enumerate()
        .map(|(index, source)| citation_for(index + 1, source))
        .collect::<Vec<_>>();
    let prompt = format!(
        "请解释这段文字在上下文中的含义。如果出现术语，用一两句话说明。\n\n{}",
        build_prompt("解释这段话", &sources)
    );
    let text = complete(&ai, SYSTEM_PROMPT, &prompt).await?;
    Ok(AiAnswer {
        text,
        citations,
        model: ai.model,
    })
}

/// 追问：沿用选段（解释模式）或重新检索（问答模式）的资料，并带上最近的对话。
#[allow(clippy::too_many_arguments)]
pub async fn followup(
    app: &AppHandle,
    doc_id: &str,
    mode: String,
    page: Option<u32>,
    quote: String,
    context: String,
    question: String,
    history: Vec<ChatTurn>,
) -> Result<AiAnswer, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("请先输入问题".to_string());
    }

    let ai = settings::load(app).ai;
    let (sources, max_chunks, max_annotations) = if mode == "explain" {
        let page = page.ok_or_else(|| "缺少选段页码".to_string())?;
        let quote = quote.trim();
        if quote.is_empty() {
            return Err("没有选中的文字".to_string());
        }
        let title = {
            let state = app.state::<AppState>();
            let conn = state
                .db
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            doc_name(&conn, doc_id)?
        };
        let source = Source {
            page: Some(page),
            kind: "page".to_string(),
            label: format!("《{title}》第 {} 页", page + 1),
            body: format!(
                "选段：\n{quote}\n\n上下文：\n{}",
                truncate(context.trim(), 2400)
            ),
            annotation_id: None,
            score: 1.0,
        };
        (vec![source], 1, 0)
    } else {
        let sources = {
            let state = app.state::<AppState>();
            let conn = state
                .db
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            collect_sources(&conn, doc_id, &question)?
        };
        (sources, 6, 4)
    };

    if sources.is_empty() {
        return Err("这份文档还没有可用的文字或标注。请先提取全文，或添加标注。".to_string());
    }

    let sources = select_sources(sources, max_chunks, max_annotations);
    if sources.is_empty() {
        return Err("这份文档还没有可用的文字或标注。请先提取全文，或添加标注。".to_string());
    }
    let citations = sources
        .iter()
        .enumerate()
        .map(|(index, source)| citation_for(index + 1, source))
        .collect::<Vec<_>>();
    let prompt = format!(
        "{}{}",
        build_prompt(&question, &sources),
        history_block(&history)
    );
    let text = complete(&ai, SYSTEM_PROMPT, &prompt).await?;

    Ok(AiAnswer {
        text,
        citations,
        model: ai.model,
    })
}

pub async fn answer(app: &AppHandle, doc_id: &str, question: String) -> Result<AiAnswer, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("请先输入问题".to_string());
    }

    let ai = settings::load(app).ai;
    let sources = {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        collect_sources(&conn, doc_id, &question)?
    };
    if sources.is_empty() {
        return Err("这份文档还没有可用的文字或标注。请先提取全文，或添加标注。".to_string());
    }

    let sources = select_sources(sources, 6, 4);
    let citations = sources
        .iter()
        .enumerate()
        .map(|(index, source)| citation_for(index + 1, source))
        .collect::<Vec<_>>();
    let prompt = build_prompt(&question, &sources);
    let text = complete(&ai, SYSTEM_PROMPT, &prompt).await?;

    Ok(AiAnswer {
        text,
        citations,
        model: ai.model,
    })
}

fn collect_sources(
    conn: &rusqlite::Connection,
    doc_id: &str,
    question: &str,
) -> Result<Vec<Source>, String> {
    let terms = query_terms(question);
    let exact = question.trim().to_lowercase();
    let mut sources = Vec::new();

    for chunk in db::list_chunks(conn, doc_id)? {
        sources.push(Source {
            page: Some(chunk.page),
            kind: "page".to_string(),
            label: format!("第 {} 页 · 原文", chunk.page + 1),
            body: chunk.text.clone(),
            annotation_id: None,
            score: score_text(&chunk.text, &terms, Some(&exact)),
        });
    }

    for annotation in db::list_annotations(conn, doc_id)?
        .into_iter()
        .filter(|annotation| !annotation.deleted)
    {
        let quote = annotation
            .anchor
            .get("quote")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let body = format!(
            "{}{}{}",
            quote,
            if annotation.body.trim().is_empty() {
                ""
            } else {
                "\n"
            },
            annotation.body.trim()
        );
        if body.trim().is_empty() {
            continue;
        }
        let tags = if annotation.tags.is_empty() {
            String::new()
        } else {
            format!("\n标签：{}", annotation.tags.join("、"))
        };
        sources.push(Source {
            page: Some(annotation.page),
            kind: "annotation".to_string(),
            label: format!("第 {} 页 · 标注", annotation.page + 1),
            body: format!("{body}{tags}"),
            annotation_id: Some(annotation.id.clone()),
            score: score_text(&format!("{body}{tags}"), &terms, Some(&exact)) * 1.25,
        });
    }

    Ok(sources)
}

pub async fn summarize(
    app: &AppHandle,
    doc_id: &str,
    annotations_only: bool,
) -> Result<AiAnswer, String> {
    let ai = settings::load(app).ai;
    let (sources, title) = {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let title = doc_name(&conn, doc_id)?;
        let mut sources = Vec::new();

        for annotation in db::list_annotations(&conn, doc_id)?
            .into_iter()
            .filter(|annotation| !annotation.deleted)
        {
            let quote = annotation
                .anchor
                .get("quote")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let body = format!(
                "{}{}{}",
                quote,
                if annotation.body.trim().is_empty() {
                    ""
                } else {
                    "\n"
                },
                annotation.body.trim()
            );
            if body.trim().is_empty() {
                continue;
            }
            sources.push(Source {
                page: Some(annotation.page),
                kind: "annotation".to_string(),
                label: format!("第 {} 页 · 标注", annotation.page + 1),
                body,
                annotation_id: Some(annotation.id.clone()),
                score: 1.0,
            });
        }

        if !annotations_only {
            let chunks = db::list_chunks(&conn, doc_id)?;
            if chunks.is_empty() {
                return Err("还没有提取全文。请先在 AI 面板里提取全文。".to_string());
            }
            let take = chunks.len().min(10);
            for index in 0..take {
                let index = if take == 1 {
                    0
                } else {
                    index * (chunks.len() - 1) / (take - 1)
                };
                let chunk = &chunks[index];
                sources.push(Source {
                    page: Some(chunk.page),
                    kind: "page".to_string(),
                    label: format!("第 {} 页 · 原文", chunk.page + 1),
                    body: chunk.text.clone(),
                    annotation_id: None,
                    score: 1.0,
                });
            }
        }

        (sources, title)
    };

    if sources.is_empty() {
        return Err(if annotations_only {
            "这份文档还没有标注可以总结".to_string()
        } else {
            "这份文档还没有可用的文字".to_string()
        });
    }

    let selected = if annotations_only {
        select_sources(sources, 0, 20)
    } else {
        select_sources(sources, 8, 6)
    };
    let citations = selected
        .iter()
        .enumerate()
        .map(|(index, source)| citation_for(index + 1, source))
        .collect::<Vec<_>>();

    let question = if annotations_only {
        format!("请总结我在《{title}》里标注关注的主题、观点与仍有疑问的地方。")
    } else {
        format!("请总结《{title}》的核心内容、主要论点与结论。")
    };
    let prompt = build_prompt(&question, &selected);
    let text = complete(&ai, SYSTEM_PROMPT, &prompt).await?;

    Ok(AiAnswer {
        text,
        citations,
        model: ai.model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_short_text_stays_whole() {
        let chunks = chunk_text("第一段\n第二段");
        assert_eq!(chunks, vec!["第一段\n第二段"]);
        assert!(chunk_text("   ").is_empty());
    }

    #[test]
    fn history_block_keeps_only_recent_turns() {
        let history: Vec<ChatTurn> = (0..10)
            .map(|index| ChatTurn {
                role: if index % 2 == 0 { "user" } else { "assistant" }.to_string(),
                content: format!("第{index}轮"),
            })
            .collect();

        let block = history_block(&history);
        assert!(block.contains("用户：第2轮"));
        assert!(block.contains("助手：第3轮"));
        assert!(block.contains("第9轮"));
        assert!(!block.contains("第0轮"));
        assert!(!block.contains("第1轮"));
        assert!(history_block(&[]).is_empty());
    }

    #[test]
    fn long_chinese_text_is_split() {
        let text = "这是一个很长的句子。".repeat(200);
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| !chunk.is_empty()));
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 900));
    }

    #[test]
    fn query_terms_include_chinese_bigrams_and_words() {
        let terms = query_terms("FSRS 如何安排复习？");
        assert!(terms.contains(&"fsrs".to_string()));
        assert!(terms.contains(&"复习".to_string()));
        assert!(terms.contains(&"安排".to_string()));
    }

    #[test]
    fn relevant_text_scores_higher() {
        let terms = query_terms("间隔重复");
        let relevant = score_text("间隔重复能提高长期记忆。", &terms, None);
        let irrelevant = score_text("今天天气很好，适合散步。", &terms, None);
        assert!(relevant > irrelevant);
        assert_eq!(irrelevant, 0.0);
    }

    #[test]
    fn selection_keeps_annotation_quota() {
        let mut sources = Vec::new();
        for index in 0..10 {
            sources.push(Source {
                page: Some(index),
                kind: "page".to_string(),
                label: format!("第 {} 页", index + 1),
                body: "正文".repeat(50),
                annotation_id: None,
                score: 10.0 - index as f64,
            });
        }
        for index in 0..6 {
            sources.push(Source {
                page: Some(index),
                kind: "annotation".to_string(),
                label: format!("第 {} 页 · 标注", index + 1),
                body: "标注".repeat(20),
                annotation_id: Some(format!("a{index}")),
                score: 5.0,
            });
        }

        let selected = select_sources(sources, 6, 4);
        assert!(selected.iter().filter(|item| item.kind == "page").count() <= 6);
        assert!(
            selected
                .iter()
                .filter(|item| item.kind == "annotation")
                .count()
                <= 4
        );
        assert!(!selected.is_empty());
    }
}
