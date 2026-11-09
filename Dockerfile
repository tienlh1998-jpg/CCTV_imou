# =============================================================================
# CCTV Vision Hub — image chạy production tối giản, không chứa bí mật
# =============================================================================
FROM python:3.11-slim

LABEL org.opencontainers.image.title="CCTV Vision Hub" \
      org.opencontainers.image.version="2.0.0" \
      org.opencontainers.image.description="Quản lý camera Dahua/Imou/Hikvision/ONVIF, MJPEG, PTZ, cảnh báo Telegram"

# FFmpeg là gói hệ thống BẮT BUỘC cho video/audio; curl dùng cho HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        curl \
        iproute2 \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Ho_Chi_Minh \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    CCTV_SETTINGS_FILE=/app/data/settings.json \
    CCTV_MANAGED_FILE=/app/data/managed_cameras.json \
    CCTV_RECORDINGS_DIR=/app/data/recordings \
    CCTV_SNAPSHOTS_DIR=/app/data/snapshots \
    CCTV_AUDIT_LOG=/app/data/logs/audit.jsonl \
    CCTV_APP_LOG=/app/data/logs/app.log \
    CCTV_APK_FILE=/app/data/CCTVVisionHub-v2.apk

WORKDIR /app

# Cài dependency trước để tận dụng cache layer.
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.txt

# Chỉ COPY mã nguồn Python. settings.json / managed_cameras.json / log / ZIP / APK
# bị .dockerignore loại trừ; build script cũng không vào image.
COPY *.py ./
COPY dahua ./dahua
COPY templates ./templates
COPY static ./static

# User không đặc quyền (uid/gid 10001) và thư mục dữ liệu ghi được.
RUN groupadd -g 10001 cctv \
    && useradd -u 10001 -g cctv -s /usr/sbin/nologin cctv \
    && mkdir -p /app/data/recordings /app/data/snapshots /app/data/logs \
    && chown -R cctv:cctv /app/data

USER 10001

EXPOSE 8080

# Healthcheck công khai, không lộ bí mật. Ứng dụng trả 503/200 tùy trạng thái.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["python", "app.py"]
