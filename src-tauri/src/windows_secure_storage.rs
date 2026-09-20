use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

const READ_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$protected = [IO.File]::ReadAllBytes($env:BETA_LIFE_API_KEY_PATH)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))"#;

const WRITE_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($env:BETA_LIFE_API_KEY_PATH, $protected)"#;

fn run_powershell(script: &str, input: Option<&str>, key_path: &Path) -> Result<Output, String> {
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("BETA_LIFE_API_KEY_PATH", key_path)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Windows 安全存储：{error}"))?;

    if let Some(value) = input {
        child
            .stdin
            .take()
            .ok_or_else(|| "无法写入 Windows 安全存储".to_string())?
            .write_all(value.as_bytes())
            .map_err(|error| format!("无法写入 Windows 安全存储：{error}"))?;
    }

    child
        .wait_with_output()
        .map_err(|error| format!("Windows 安全存储没有正常结束：{error}"))
}

pub fn read_key(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let output = run_powershell(READ_SCRIPT, None, path)?;
    if !output.status.success() {
        return Err("无法从 Windows 安全存储读取 API key".into());
    }
    let key = String::from_utf8(output.stdout)
        .map_err(|_| "Windows 安全存储中的 API key 不是有效的 UTF-8".to_string())?;
    Ok((!key.is_empty()).then_some(key))
}

pub fn write_key(path: &Path, key: &str) -> Result<(), String> {
    let output = run_powershell(WRITE_SCRIPT, Some(key), path)?;
    if output.status.success() {
        Ok(())
    } else {
        Err("无法将 API key 保存到 Windows 安全存储".into())
    }
}

pub fn delete_key(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法清除 Windows 安全存储：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_key_file_is_not_an_error() {
        let path = std::env::temp_dir().join(format!(
            "beta-life-nonexistent-dpapi-test-file-{}",
            std::process::id()
        ));
        assert_eq!(
            read_key(&path).expect("missing key should be accepted"),
            None
        );
    }
}
