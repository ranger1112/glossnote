//! 网页剪藏的网络侧：抓取公开页面与图片。
//!
//! 提取正文、生成快照在前端完成；这里只负责带大小/超时/SSRF 限制的 HTTP。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{
    header::{CONTENT_TYPE, LOCATION},
    Client, ClientBuilder, Url,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::Path,
    time::Duration,
};

const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_IMAGES: usize = 100;
const MAX_REDIRECTS: usize = 5;
const USER_AGENT: &str = "GlossNote/0.5 (+https://github.com/ranger1112/glossnote)";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedWebPage {
    pub final_url: String,
    pub html: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedAsset {
    pub url: String,
    pub data_url: Option<String>,
    pub error: Option<String>,
}

fn client_builder(timeout_secs: u64) -> ClientBuilder {
    Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        // 重定向手动跟随，每一跳都要重新做私网校验。
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
}

fn client(timeout_secs: u64) -> Result<Client, String> {
    client_builder(timeout_secs)
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))
}

/// 把连接固定在校验过的地址上，避免校验与 reqwest 各自解析一次 DNS
/// 造成 DNS rebinding（校验时是公网 IP，连接时变成内网 IP）。
fn pinned_client(timeout_secs: u64, host: &str, addrs: &[SocketAddr]) -> Result<Client, String> {
    client_builder(timeout_secs)
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))
}

fn header_mime(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn looks_like_html(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    head.contains("<html") || head.contains("<!doctype html") || head.contains("<body")
}

fn allow_private_urls() -> bool {
    // 桌面冒烟测试用本地 HTTP 服务；只在 debug 构建且显式设置环境变量时放行。
    cfg!(debug_assertions) && std::env::var_os("GLOSSNOTE_ALLOW_PRIVATE_URLS").is_some()
}

/// 非全局 IPv4 网段。std 的 is_private / is_documentation 没有覆盖
/// CGNAT、基准测试、IETF 保留、240/4 等段，这里按 IANA 特殊用途地址表补齐。
fn ipv4_is_non_global(v4: std::net::Ipv4Addr) -> bool {
    let octets = v4.octets();
    v4.is_private()
        || v4.is_loopback()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_unspecified()
        || v4.is_multicast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
        || octets[0] >= 240
}

fn blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_non_global(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ipv4_is_non_global(v4);
            }
            let segments = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                // NAT64 64:ff9b::/96 与本地 NAT64 64:ff9b:1::/48
                || (segments[0] == 0x0064 && segments[1] == 0xff9b)
                // 6to4 2002::/16 与 Teredo 2001::/32
                || segments[0] == 0x2002
                || (segments[0] == 0x2001 && segments[1] == 0)
                // 100::/64 仅用于丢弃
                || (segments[0] == 0x0100
                    && segments[1] == 0
                    && segments[2] == 0
                    && segments[3] == 0)
        }
    }
}

fn ensure_public_ip(ip: IpAddr) -> Result<(), String> {
    if allow_private_urls() {
        return Ok(());
    }
    if blocked_ip(ip) {
        Err(format!("不能抓取内网或本机地址：{ip}"))
    } else {
        Ok(())
    }
}

/// 返回校验后的 URL，以及域名对应的已校验地址（IP 字面量不需要固定）。
async fn validate_public_url(url: Url) -> Result<(Url, Option<(String, Vec<SocketAddr>)>), String> {
    match url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("只支持 http/https 链接（当前为 {scheme}）")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("链接不能包含用户名或密码".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "链接缺少主机名".to_string())?
        .to_string();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        ensure_public_ip(ip)?;
        return Ok((url, None));
    }

    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return Err("不能抓取本机地址".to_string());
    }

    let port = url
        .port_or_known_default()
        .ok_or_else(|| "链接缺少端口".to_string())?;
    let lookup_host = host.clone();
    let addresses = tauri::async_runtime::spawn_blocking(move || {
        (lookup_host.as_str(), port).to_socket_addrs()
    })
    .await
    .map_err(|error| format!("解析域名失败：{error}"))?
    .map_err(|error| format!("解析域名失败：{error}"))?;

    let mut resolved = Vec::new();
    for address in addresses {
        ensure_public_ip(address.ip())?;
        resolved.push(address);
    }
    if resolved.is_empty() {
        return Err("域名没有可用地址".to_string());
    }
    Ok((url, Some((host, resolved))))
}

async fn get_following_redirects(
    timeout_secs: u64,
    start: Url,
) -> Result<(Url, reqwest::Response), String> {
    let mut current = start;
    for attempt in 0..=MAX_REDIRECTS {
        let (url, pin) = validate_public_url(current).await?;
        // 每一跳都用校验过的地址建客户端，防止 DNS 在校验与连接之间被改写。
        let client = match &pin {
            Some((host, addrs)) => pinned_client(timeout_secs, host, addrs)?,
            None => client(timeout_secs)?,
        };
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| format!("请求失败：{error}"))?;

        if response.status().is_redirection() {
            if attempt == MAX_REDIRECTS {
                return Err("重定向次数过多".to_string());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "重定向缺少 Location".to_string())?;
            current = url
                .join(location)
                .map_err(|error| format!("重定向地址无效：{error}"))?;
            continue;
        }
        return Ok((url, response));
    }
    Err("重定向次数过多".to_string())
}

async fn read_limited(
    mut response: reqwest::Response,
    limit: usize,
    what: &str,
) -> Result<Vec<u8>, String> {
    if let Some(length) = response.content_length() {
        if length > limit as u64 {
            return Err(format!("{what}超过大小限制"));
        }
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取{what}失败：{error}"))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(format!("{what}超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn guess_image_mime(url: &Url) -> Option<&'static str> {
    let extension = Path::new(url.path())
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

pub async fn fetch_web_page(url: String) -> Result<FetchedWebPage, String> {
    let start = Url::parse(url.trim()).map_err(|error| format!("网址格式不正确：{error}"))?;
    let (final_url, response) = get_following_redirects(20, start).await?;
    if !response.status().is_success() {
        return Err(format!("页面返回 HTTP {}", response.status()));
    }

    let mime = header_mime(&response);
    let bytes = read_limited(response, MAX_HTML_BYTES, "页面").await?;
    let html_like = looks_like_html(&bytes);
    let declared_html = mime.is_empty()
        || mime == "text/html"
        || mime == "application/xhtml+xml"
        || mime == "application/xml"
        || mime == "text/plain"
        || mime == "application/octet-stream";
    if !declared_html && !html_like {
        return Err(format!("链接不是 HTML 页面（{mime}）"));
    }
    if !html_like && (mime.is_empty() || mime == "text/plain" || mime == "application/octet-stream")
    {
        return Err("链接内容看起来不是 HTML 页面".to_string());
    }

    let html = crate::library::decode_text(&bytes)?;
    Ok(FetchedWebPage {
        final_url: final_url.to_string(),
        html,
    })
}

async fn download_one(
    timeout_secs: u64,
    raw: &str,
    remaining: &mut usize,
) -> Result<String, String> {
    let start = Url::parse(raw).map_err(|error| format!("图片地址无效：{error}"))?;
    let (final_url, response) = get_following_redirects(timeout_secs, start).await?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let mut mime = header_mime(&response);
    if mime.is_empty() || mime == "application/octet-stream" {
        mime = guess_image_mime(&final_url)
            .ok_or_else(|| "响应不是图片".to_string())?
            .to_string();
    }
    if !mime.starts_with("image/") {
        return Err(format!("响应不是图片（{mime}）"));
    }

    let limit = (*remaining).min(MAX_IMAGE_BYTES);
    if limit == 0 {
        return Err("图片总量超过限制".to_string());
    }
    let bytes = read_limited(response, limit, "图片").await?;
    *remaining -= bytes.len();
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

pub async fn download_web_assets(urls: Vec<String>) -> Result<Vec<DownloadedAsset>, String> {
    if urls.len() > MAX_IMAGES {
        return Err(format!("一次最多下载 {MAX_IMAGES} 张图片"));
    }

    let mut remaining = MAX_TOTAL_IMAGE_BYTES;
    let mut cache: HashMap<String, DownloadedAsset> = HashMap::new();
    let mut result = Vec::with_capacity(urls.len());

    for url in urls {
        if let Some(asset) = cache.get(&url) {
            result.push(asset.clone());
            continue;
        }
        let asset = match download_one(15, &url, &mut remaining).await {
            Ok(data_url) => DownloadedAsset {
                url: url.clone(),
                data_url: Some(data_url),
                error: None,
            },
            Err(error) => DownloadedAsset {
                url: url.clone(),
                data_url: None,
                error: Some(error),
            },
        };
        cache.insert(url, asset.clone());
        result.push(asset);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_loopback_ips() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.1.1",
            "169.254.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(blocked_ip(ip.parse().unwrap()), "{ip} 应被拒绝");
        }
        assert!(!blocked_ip("8.8.8.8".parse().unwrap()));
        assert!(!blocked_ip("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn rejects_non_global_ranges() {
        for ip in [
            "100.64.0.1",
            "100.100.100.200",
            "0.1.2.3",
            "198.18.0.1",
            "192.0.0.1",
            "240.0.0.1",
            "64:ff9b::a00:1",
            "2002:7f00:1::1",
            "2001::1",
            "100::1",
        ] {
            assert!(blocked_ip(ip.parse().unwrap()), "{ip} 应被拒绝");
        }
    }

    #[test]
    fn fetches_page_and_images_from_local_server() {
        std::env::set_var("GLOSSNOTE_ALLOW_PRIVATE_URLS", "1");
        let (base, server) = spawn_test_server();
        let page = tauri::async_runtime::block_on(fetch_web_page(format!("{base}/page.html")))
            .expect("抓取页面");
        assert!(page.html.contains("hello"));

        let assets =
            tauri::async_runtime::block_on(download_web_assets(vec![format!("{base}/pic.png")]))
                .expect("下载图片");
        assert_eq!(assets.len(), 1);
        assert!(assets[0]
            .data_url
            .as_deref()
            .is_some_and(|value| value.starts_with("data:image/png;base64,")));
        server.join().unwrap();
    }

    fn spawn_test_server() -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut buffer = [0u8; 1024];
                let read = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]);
                let (content_type, body): (&str, &[u8]) = if request.contains("GET /pic.png") {
                    (
                        "image/png",
                        &[
                            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
                            b'I', b'H', b'D', b'R',
                        ],
                    )
                } else {
                    (
                        "text/html",
                        b"<!doctype html><html><body>hello</body></html>",
                    )
                };
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(header.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            }
        });
        (base, handle)
    }

    #[test]
    fn recognizes_html_and_image_mime() {
        assert!(looks_like_html(
            b"<!doctype html><html><body>x</body></html>"
        ));
        assert!(!looks_like_html(b"%PDF-1.7"));
        assert_eq!(
            guess_image_mime(&Url::parse("https://example.com/a/b.PNG?x=1").unwrap()),
            Some("image/png")
        );
        assert_eq!(
            guess_image_mime(&Url::parse("https://example.com/a/b.svg").unwrap()),
            Some("image/svg+xml")
        );
        assert_eq!(
            guess_image_mime(&Url::parse("https://example.com/a/b.bin").unwrap()),
            None
        );
    }
}
