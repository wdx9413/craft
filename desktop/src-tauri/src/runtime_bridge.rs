use std::{io::{Read, Write}, net::{Ipv4Addr, SocketAddr, TcpStream}, time::Duration};

/// The address and token are received from the child, never from a webpage.
pub struct Backend { pub port: u16, pub token: String }

pub fn valid_token(token: &str) -> bool {
    token.len() == 43 && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn validate_request(method: &str, path: &str, body: &str) -> Result<(), String> {
    if !matches!(method, "GET" | "POST" | "PATCH" | "DELETE") || !path.starts_with("/api/")
        || path.contains(['\r', '\n', '#']) || path.contains("..") || body.len() > 65_536 {
        return Err("Unsupported Workbench request".into());
    }
    Ok(())
}

pub fn decode_response(raw: &[u8]) -> Result<(u16, String), String> {
    let text = std::str::from_utf8(raw).map_err(|_| "Invalid HTTP encoding")?;
    let (headers, body) = text.split_once("\r\n\r\n").ok_or("Incomplete HTTP response")?;
    let status = headers.lines().next().and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok()).filter(|code| (100..=599).contains(code)).ok_or("Invalid HTTP status")?;
    let mut length = None;
    for line in headers.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") { length = Some(value.trim().parse::<usize>().map_err(|_| "Invalid content length")?); }
            if name.eq_ignore_ascii_case("transfer-encoding") { return Err("Unexpected transfer encoding".into()); }
        }
    }
    if length != Some(body.len()) { return Err("Incomplete HTTP body".into()); }
    Ok((status, body.into()))
}

impl Backend {
    pub fn request(&self, method: &str, path: &str, body: &str) -> Result<(u16, String), String> {
        validate_request(method, path, body)?;
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(Duration::from_secs(30))).map_err(|e| e.to_string())?;
        stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
        let request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", self.port, self.token, body.len());
        stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        stream.take(2_097_153).read_to_end(&mut raw).map_err(|e| e.to_string())?;
        if raw.len() > 2_097_152 { return Err("HTTP response exceeds limit".into()); }
        decode_response(&raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn runtime_token_contract() {
        assert!(valid_token(&"a".repeat(43)));
        assert!(valid_token(&format!("{}-_", "A".repeat(41))));
        for token in ["", &"a".repeat(42), &"a".repeat(44), &format!("{}\r", "a".repeat(42)), &format!("{}é", "a".repeat(41))] {
            assert!(!valid_token(token));
        }
    }
    #[test] fn request_scope() {
        for method in ["GET", "POST", "PATCH", "DELETE"] { assert!(validate_request(method, "/api/test", "{}").is_ok()); }
        for (method, path) in [("CONNECT", "/api/x"), ("GET", "https://evil.test"), ("GET", "/api/../x"), ("GET", "/api/x\r\n"), ("GET", "/api/x#x")] { assert!(validate_request(method, path, "").is_err()); }
        assert!(validate_request("POST", "/api/x", &"x".repeat(65_537)).is_err());
    }
    #[test] fn response_contract() {
        assert_eq!(decode_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap(), (200, "{}".into()));
        for raw in [b"\xff".as_slice(), b"bad", b"HTTP/1.1 invalid\r\n\r\n", b"HTTP/1.1 999\r\n\r\n", b"HTTP/1.1 200\r\nContent-Length: x\r\n\r\n", b"HTTP/1.1 200\r\nTransfer-Encoding: chunked\r\n\r\n", b"HTTP/1.1 200\r\nContent-Length: 2\r\n\r\nx"] { assert!(decode_response(raw).is_err()); }
    }
    #[test] fn real_loopback() {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = [0; 1024];
            let n = socket.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]);
            assert!(request.contains("Authorization: Bearer owned-token"));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        });
        assert_eq!(Backend { port, token: "owned-token".into() }.request("GET", "/api/test", "").unwrap().0, 200);
        worker.join().unwrap();
    }
}
