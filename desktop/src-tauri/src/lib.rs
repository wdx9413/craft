use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

struct RuntimeState {
    child: Mutex<Option<Child>>,
    backend: Mutex<Option<runtime_bridge::Backend>>,
}

mod runtime_bridge;
mod entry_window;

#[tauri::command]
fn entry_window_mode(window: tauri::WebviewWindow, mode: String) -> Result<(), String> {
    require_main(&window)?;
    let (width, height) = entry_window::dimensions(&mode)?;
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
struct WorkbenchResponse { status: u16, body: String }

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Window identity unavailable")?;
    let bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    if window.label() != "main" || !bundled {
        return Err("Command requires the bundled main window".into());
    }
    Ok(())
}

#[tauri::command]
async fn workbench_request(window: tauri::WebviewWindow, state: tauri::State<'_, RuntimeState>, method: String, path: String, body: String) -> Result<WorkbenchResponse, String> {
    require_main(&window)?;
    let (port, token) = {
        let backend = state.backend.lock().map_err(|_| "Runtime lock unavailable")?;
        let backend = backend.as_ref().ok_or("Runtime unavailable")?;
        (backend.port, backend.token.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (status, body) = runtime_bridge::Backend { port, token }.request(&method, &path, &body)?;
        Ok(WorkbenchResponse { status, body })
    }).await.map_err(|_| "Runtime request interrupted".to_owned())?
}

fn development_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("Craft repository root")
}

fn runtime_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, bool), String> {
    if cfg!(debug_assertions) {
        let root = development_root();
        let node = std::env::var_os("CRAFT_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        return Ok((node, root.join("core/cli.ts"), true));
    }
    let root = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("app");
    Ok((
        root.join(if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        }),
        root.join("dist/core/cli.js"),
        false,
    ))
}

fn start_workbench(app: &AppHandle) -> Result<(Child, Url), String> {
    let (node, cli, typescript) = runtime_paths(app)?;
    let mut command = Command::new(node);
    // The Node runtime resolves an explicit environment, settings, then ~/.craft_data.
    if typescript { command.arg("--experimental-strip-types"); }
    let cli_argument = cli.to_string_lossy().replace('\\', "/");
    let mut child = command.arg(cli_argument).args(["serve", "--port", "0"])
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|error| format!("无法启动 Craft 本地运行时：{error}"))?;
    let stdout = child.stdout.take().ok_or("Craft 本地运行时未提供启动输出")?;
    let stderr = child.stderr.take().ok_or("Craft 本地运行时未提供错误输出")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = line.strip_prefix("Craft Workbench: ") { let _ = sender.send(url.to_owned()); }
        }
    });
    std::thread::spawn(move || { let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink()); });
    let result = receiver.recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| "Craft 本地运行时启动失败：超时或进程退出".to_owned())
        .and_then(|line| Url::parse(line.trim()).map_err(|_| "Craft 返回了无效地址".to_owned()))
        .and_then(|url| {
            let token = url.fragment().and_then(|value| value.strip_prefix("token=")).unwrap_or("");
            if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none()
                || !runtime_bridge::valid_token(token) {
                return Err("Craft 返回了未授权的运行时地址".into());
            }
            Ok(url)
        });
    match result {
        Ok(url) => Ok((child, url)),
        Err(error) => { let _ = child.kill(); let _ = child.wait(); Err(error) }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("craft-entry-open", ());
    }
}

#[tauri::command]
fn open_embedded_page(window: tauri::WebviewWindow, app: AppHandle, url: String) -> Result<(), String> {
    require_main(&window)?;
    let parsed =
        Url::parse(&url).map_err(|_| "请输入完整的 http:// 或 https:// 地址".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("内嵌网页只接受 http:// 或 https:// 地址".into());
    }
    if let Some(window) = app.get_webview_window("embedded") {
        window.close().map_err(|error| error.to_string())?;
    }
    WebviewWindowBuilder::new(&app, "embedded", WebviewUrl::External(parsed))
        .title("网页查看 · Craft Workbench")
        .inner_size(1180.0, 820.0)
        .min_inner_size(760.0, 520.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Opens a separately profiled, visible local Edge session for the person to complete login.
/// The profile is not copied into the WebView and Craft never reads cookies or credentials.
#[tauri::command]
fn open_managed_browser(window: tauri::WebviewWindow, app: AppHandle, url: String) -> Result<(), String> {
    require_main(&window)?;
    let parsed = Url::parse(&url).map_err(|_| "请输入完整的 http:// 或 https:// 地址".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("受管浏览器只接受 http:// 或 https:// 地址".into());
    }
    let profile = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("browser-profile");
    std::fs::create_dir_all(&profile).map_err(|error| format!("无法创建本地浏览器资料目录：{error}"))?;
    let edge = [
        PathBuf::from(r"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"),
        PathBuf::from(r"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"),
        PathBuf::from("msedge.exe"),
    ].into_iter().find(|candidate| candidate == &PathBuf::from("msedge.exe") || candidate.is_file())
        .ok_or("未找到 Microsoft Edge；请安装或从已有浏览器开启本地 CDP 后连接")?;
    Command::new(edge)
        .arg("--no-first-run")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--remote-debugging-port=9222")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("无法启动受管浏览器：{error}"))?;
    Ok(())
}

#[tauri::command]
fn notify(window: tauri::WebviewWindow, app: AppHandle, title: String, body: String) -> Result<(), String> {
    require_main(&window)?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

pub fn run() {
    let state = RuntimeState {
        child: Mutex::new(None),
        backend: Mutex::new(None),
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_main(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let (child, url) = start_workbench(app.handle())?;
            *state.child.lock().expect("runtime state") = Some(child);
            *state.backend.lock().expect("runtime state") = Some(runtime_bridge::Backend {
                port: url.port().expect("validated runtime port"),
                token: url.fragment().expect("validated token").trim_start_matches("token=").into(),
            });
            app.manage(state);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Craft")
                .inner_size(780.0, 700.0)
                .min_inner_size(380.0, 400.0)
                .build()?;
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_embedded_page, open_managed_browser, notify, workbench_request, entry_window_mode])
        .build(tauri::generate_context!())
        .expect("error while building Craft Workbench")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<RuntimeState>() {
                    if let Some(mut child) = state.child.lock().expect("runtime state").take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
