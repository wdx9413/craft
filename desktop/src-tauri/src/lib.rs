use std::{
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

struct RuntimeState {
    child: Mutex<Option<Child>>,
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
    // The sidecar must not depend on a shell-specific home directory. Keeping its state
    // beneath the desktop application's local data directory also makes debug and packaged
    // startup behave the same way.
    let data_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位 Craft 本地数据目录：{error}"))?
        .join("craft-data");
    std::fs::create_dir_all(&data_root)
        .map_err(|error| format!("无法创建 Craft 本地数据目录：{error}"))?;
    let mut command = Command::new(node);
    command.env("CRAFT_DATA_DIR", data_root);
    if typescript {
        command.arg("--experimental-strip-types");
    }
    // Node's TypeScript entrypoint is more reliable with a slash-normalized Windows drive
    // path; a raw backslash drive path was parsed as `D:` by the spawned Node runtime.
    let cli_argument = cli.to_string_lossy().replace('\\', "/");
    let mut child = command
        .arg(cli_argument)
        .args(["serve", "--port", "0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Craft 本地运行时：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Craft 本地运行时未提供启动输出")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Craft 本地运行时未提供错误输出")?;
    let mut lines = BufReader::new(stdout).lines();
    for _ in 0..8 {
        match lines.next() {
            Some(Ok(line)) => {
                if let Some(url) = line.strip_prefix("Craft Workbench: ") {
                    let url = Url::parse(url.trim())
                        .map_err(|error| format!("Craft 返回了无效地址：{error}"))?;
                    return Ok((child, url));
                }
            }
            Some(Err(error)) => return Err(error.to_string()),
            None => break,
        }
    }
    let _ = child.wait();
    let mut detail = String::new();
    let _ = stderr.read_to_string(&mut detail);
    let detail = detail.trim();
    if detail.is_empty() {
        Err("Craft 本地运行时没有在预期输出中报告 Workbench 地址".into())
    } else {
        Err(format!("Craft 本地运行时启动失败：{}", detail.chars().take(1_000).collect::<String>()))
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn open_embedded_page(app: AppHandle, url: String) -> Result<(), String> {
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
fn open_managed_browser(app: AppHandle, url: String) -> Result<(), String> {
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
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
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
            app.manage(state);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Craft Workbench")
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 620.0)
                .build()?;
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_embedded_page, open_managed_browser, notify])
        .build(tauri::generate_context!())
        .expect("error while building Craft Workbench")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<RuntimeState>() {
                    if let Some(mut child) = state.child.lock().expect("runtime state").take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
