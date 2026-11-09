"""
Telegram Bot Service - Giao tiếp Telegram Bot API (pure Python stdlib).

Bảo mật:
- TLS luôn xác thực chứng chỉ; hỗ trợ CCTV_CA_BUNDLE, fallback certifi.
- Không bao giờ tắt xác thực chứng chỉ hoặc bỏ kiểm tra hostname.
- Token trong URL path của Telegram được redact khỏi log và thông điệp lỗi.
"""

import json
import logging
import os
import re
import ssl
import urllib.error
import urllib.request
import uuid

logger = logging.getLogger("telegram_service")

_TOKEN_RE = re.compile(r"(?<!\d)\d{6,}:[A-Za-z0-9_-]{20,}\b")


def _redact(text) -> str:
    return _TOKEN_RE.sub("bot***", str(text or ""))


def _telegram_disabled() -> bool:
    value = str(os.environ.get("CCTV_DISABLE_TELEGRAM", "")).strip().lower()
    return value in {"1", "true", "yes", "on"}


def _disabled_result() -> dict:
    return {"ok": False, "error": "Gửi Telegram đang bị tắt bởi CCTV_DISABLE_TELEGRAM."}


def _get_ssl_context():
    """Tạo SSL context xác thực đầy đủ.

    Thứ tự CA: ``CCTV_CA_BUNDLE`` -> ``certifi`` -> CA hệ thống.
    Nếu CA bundle cấu hình sai, raise lỗi rõ ràng thay vì hạ cấp TLS.
    """
    bundle = (os.environ.get("CCTV_CA_BUNDLE") or "").strip()
    cafile = bundle
    if not cafile:
        try:
            import certifi
            cafile = certifi.where()
        except Exception:
            cafile = None
    try:
        context = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    except Exception as exc:
        raise RuntimeError(
            "Không nạp được CA cho Telegram. Kiểm tra CCTV_CA_BUNDLE hoặc cài certifi. "
            f"Chi tiết: {_redact(exc)}"
        ) from exc
    # Đảm bảo không bị hạ cấp bởi bất kỳ cấu hình nào.
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def _ssl_or_error():
    try:
        return _get_ssl_context(), None
    except Exception as exc:
        return None, _redact(exc)


def send_telegram_message(bot_token: str, chat_id: str, text: str, parse_mode: str = "Markdown") -> dict:
    """Gửi tin nhắn văn bản tới Telegram chat_id."""
    if not bot_token or not chat_id:
        return {"ok": False, "error": "Thiếu Bot Token hoặc Chat ID!"}
    if _telegram_disabled():
        return _disabled_result()

    bot_token = bot_token.strip()
    chat_id = str(chat_id).strip()
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    context, ssl_error = _ssl_or_error()
    if ssl_error:
        return {"ok": False, "error": ssl_error}

    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "CCTVVisionHub/2.0"},
    )

    try:
        with urllib.request.urlopen(request, timeout=10.0, context=context) as response:
            body = response.read().decode("utf-8")
            result = json.loads(body)
            return {"ok": True, "result": result.get("result")}
    except urllib.error.HTTPError as exc:
        error_body = _redact(exc.read().decode("utf-8", errors="ignore"))
        logger.error("Telegram sendMessage HTTP error: %s - %s", exc.code, error_body)
        return {"ok": False, "error": f"Lỗi Telegram ({exc.code}): {error_body}"}
    except ssl.SSLError as exc:
        message = _telegram_tls_message(exc)
        logger.error(message)
        return {"ok": False, "error": message}
    except Exception as exc:
        message = _redact(f"Lỗi kết nối Telegram: {exc}")
        logger.error(message)
        return {"ok": False, "error": message}


def send_telegram_photo(
    bot_token: str,
    chat_id: str,
    photo_bytes: bytes,
    caption: str = "",
    filename: str = "alert.jpg",
    parse_mode: str = "Markdown",
) -> dict:
    """Gửi ảnh snapshot tới Telegram chat_id bằng multipart/form-data."""
    if not bot_token or not chat_id:
        return {"ok": False, "error": "Thiếu Bot Token hoặc Chat ID!"}
    if not photo_bytes:
        return {"ok": False, "error": "Dữ liệu ảnh trống!"}
    if _telegram_disabled():
        return _disabled_result()

    bot_token = bot_token.strip()
    chat_id = str(chat_id).strip()
    url = f"https://api.telegram.org/bot{bot_token}/sendPhoto"
    context, ssl_error = _ssl_or_error()
    if ssl_error:
        return {"ok": False, "error": ssl_error}

    boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
    body_parts = []

    body_parts.append(f"--{boundary}\r\n".encode("latin1"))
    body_parts.append(b'Content-Disposition: form-data; name="chat_id"\r\n\r\n')
    body_parts.append(f"{chat_id}\r\n".encode("utf-8"))

    if caption:
        body_parts.append(f"--{boundary}\r\n".encode("latin1"))
        body_parts.append(b'Content-Disposition: form-data; name="caption"\r\n\r\n')
        body_parts.append(f"{caption}\r\n".encode("utf-8"))

        body_parts.append(f"--{boundary}\r\n".encode("latin1"))
        body_parts.append(b'Content-Disposition: form-data; name="parse_mode"\r\n\r\n')
        body_parts.append(f"{parse_mode}\r\n".encode("utf-8"))

    body_parts.append(f"--{boundary}\r\n".encode("latin1"))
    body_parts.append(
        f'Content-Disposition: form-data; name="photo"; filename="{filename}"\r\n'.encode("utf-8")
    )
    body_parts.append(b"Content-Type: image/jpeg\r\n\r\n")
    body_parts.append(photo_bytes)
    body_parts.append(b"\r\n")
    body_parts.append(f"--{boundary}--\r\n".encode("latin1"))

    full_body = b"".join(body_parts)
    request = urllib.request.Request(
        url,
        data=full_body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(full_body)),
            "User-Agent": "CCTVVisionHub/2.0",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=15.0, context=context) as response:
            body = response.read().decode("utf-8")
            result = json.loads(body)
            return {"ok": True, "result": result.get("result")}
    except urllib.error.HTTPError as exc:
        error_body = _redact(exc.read().decode("utf-8", errors="ignore"))
        logger.error("Telegram sendPhoto HTTP error: %s - %s", exc.code, error_body)
        return {"ok": False, "error": f"Lỗi Telegram ({exc.code}): {error_body}"}
    except ssl.SSLError as exc:
        message = _telegram_tls_message(exc)
        logger.error(message)
        return {"ok": False, "error": message}
    except Exception as exc:
        message = _redact(f"Lỗi kết nối Telegram: {exc}")
        logger.error(message)
        return {"ok": False, "error": message}


def _telegram_tls_message(exc: Exception) -> str:
    return (
        "Lỗi TLS khi kết nối Telegram: "
        f"{_redact(exc)}. "
        "Kiểm tra chứng chỉ máy chủ hoặc đặt biến môi trường CCTV_CA_BUNDLE "
        "trỏ tới file CA tin cậy. Không tự động tắt xác thực chứng chỉ."
    )


def test_telegram_bot(bot_token: str, chat_id: str, sample_photo: bytes | None = None) -> dict:
    """Kiểm tra bot token bằng getMe và gửi tin nhắn/ảnh chào mừng thử nghiệm."""
    if not bot_token or not chat_id:
        return {"ok": False, "error": "Vui lòng nhập đầy đủ Bot Token và Chat ID!"}
    if _telegram_disabled():
        return _disabled_result()

    bot_token = bot_token.strip()
    chat_id = str(chat_id).strip()
    context, ssl_error = _ssl_or_error()
    if ssl_error:
        return {"ok": False, "error": ssl_error}

    get_me_url = f"https://api.telegram.org/bot{bot_token}/getMe"
    try:
        with urllib.request.urlopen(get_me_url, timeout=8.0, context=context) as response:
            me_data = json.loads(response.read().decode("utf-8"))
            if not me_data.get("ok"):
                return {"ok": False, "error": "Bot Token không hợp lệ!"}
            bot_info = me_data.get("result", {})
            bot_username = bot_info.get("username", "UnknownBot")
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"Bot Token không đúng (Mã {exc.code})"}
    except ssl.SSLError as exc:
        return {"ok": False, "error": _telegram_tls_message(exc)}
    except Exception as exc:
        return {"ok": False, "error": _redact(f"Không thể kết nối Telegram: {exc}")}

    caption = (
        f"*KẾT NỐI TELEGRAM BOT THÀNH CÔNG*\n\n"
        f"Bot: `@{bot_username}`\n"
        f"Chat ID: `{chat_id}`\n"
        f"Trạng thái: CCTV Vision Hub đã sẵn sàng gửi cảnh báo."
    )

    if sample_photo:
        return send_telegram_photo(bot_token, chat_id, sample_photo,
                                   caption=caption, filename="test_connection.jpg")
    return send_telegram_message(bot_token, chat_id, caption)
